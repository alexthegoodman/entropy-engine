//! `Entropy.Worker`: run a bundled script's `onJob(input)` on a background thread, in a JavaScript
//! isolate of its own, so heavy pure-JS work (a Mesha house evaluation: 10-150 ms) never holds a
//! frame. The addon runtime has no workers, and its isolate lives on the main thread.
//!
//! A worker script is a classic script (a `deno bundle` with no imports or exports) that sets
//! `globalThis.onJob = input => result`. Inputs and results cross as JSON, so keep them small;
//! bulk output goes through the worker's own host calls - `EntropyWorker.MeshCache.put` writes
//! straight into the mesh cache the game reads (`Entropy.MeshCache`). Workers see nothing else of
//! the engine: no scene, no GPU, no addon state.
//!
//! Jobs run in order on a small pool (one or two threads; each keeps the isolate of the script it
//! last ran).
//! `start` returns a job id; `poll` returns { status: "pending" | "done" | "failed", result?,
//! error? } and forgets a finished job once read; `cancel` drops a job that has not started.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use deno_core::{op2, JsRuntime, OpState, RuntimeOptions};
use deno_error::JsErrorBox;
use serde::Serialize;

use crate::deno::addon_ops::AddonContext;
use crate::deno::mesh_cache_ops::{cache_root, put_mesh, PutOptions};
use crate::helpers::mesh_cache::cache_at;

struct Job { id: u64, script: PathBuf, input: String, cache_root: PathBuf }

enum Outcome { Done(String), Failed(String) }

#[derive(Default)]
struct Shared {
    queue: Mutex<VecDeque<Job>>,
    wake: Condvar,
    /// Started and not yet finished.
    running: Mutex<std::collections::HashSet<u64>>,
    done: Mutex<HashMap<u64, Outcome>>,
    shutdown: AtomicBool,
    next: AtomicU64,
}

pub struct WorkerPool { shared: Arc<Shared> }

impl WorkerPool {
    pub fn new(threads: usize) -> Self {
        let shared: Arc<Shared> = Arc::default();
        for i in 0..threads.max(1) {
            let shared = shared.clone();
            let _ = std::thread::Builder::new().name(format!("entropy-worker-{i}")).stack_size(16 << 20).spawn(move || run(shared));
        }
        Self { shared }
    }

    fn start(&self, script: PathBuf, input: String, cache_root: PathBuf) -> u64 {
        let id = self.shared.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared.queue.lock().unwrap_or_else(|e| e.into_inner()).push_back(Job { id, script, input, cache_root });
        self.shared.wake.notify_one();
        id
    }

    fn cancel(&self, id: u64) -> bool {
        let mut q = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
        let before = q.len();
        q.retain(|j| j.id != id);
        q.len() != before
    }

    fn poll(&self, id: u64) -> PollOut {
        if let Some(o) = self.shared.done.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            return match o {
                Outcome::Done(json) => PollOut { status: "done", result: serde_json::from_str(&json).ok(), error: None },
                Outcome::Failed(e) => PollOut { status: "failed", result: None, error: Some(e) },
            };
        }
        let queued = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|j| j.id == id);
        let running = self.shared.running.lock().unwrap_or_else(|e| e.into_inner()).contains(&id);
        if queued || running { PollOut { status: "pending", result: None, error: None } }
        else { PollOut { status: "unknown", result: None, error: None } }
    }

    fn pending(&self) -> usize {
        self.shared.queue.lock().unwrap_or_else(|e| e.into_inner()).len() + self.shared.running.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for WorkerPool {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.queue.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.shared.wake.notify_all();
    }
}

/// What a worker isolate's host calls may touch.
struct WorkerState { cache_root: PathBuf }

/// EntropyWorker.MeshCache.put: as Entropy.MeshCache.put, into the job's mesh cache.
#[op2]
fn op_worker_mesh_cache_put(
    state: &mut OpState,
    #[string] namespace: String,
    #[string] key: String,
    #[buffer] vertices: &[u8],
    #[buffer] indices: &[u8],
    #[string] meta: String,
    #[serde] options: Option<PutOptions>,
) -> Result<(), JsErrorBox> {
    let root = state.borrow::<WorkerState>().cache_root.clone();
    put_mesh(&cache_at(root), &namespace, &key, vertices, indices, meta, options).map_err(JsErrorBox::generic)
}

deno_core::extension!(entropy_worker, ops = [op_worker_mesh_cache_put]);

const BOOTSTRAP: &str = r#"
const { ops } = Deno.core;
const bytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
globalThis.EntropyWorker = {
    MeshCache: {
        put: (namespace, key, vertices, indices, meta, options) =>
            ops.op_worker_mesh_cache_put(namespace, key, bytes(vertices), bytes(indices), meta ?? "", options ?? null),
    },
};
const quiet = () => {};
globalThis.console ??= { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet };
"#;

/// The thread's isolate for `script`, made on first use. One isolate per thread at a time: V8
/// requires a thread's isolates to be dropped in the reverse order of their creation, so a job
/// for another script replaces it (scripts rarely alternate: in practice there is one).
fn isolate<'a>(current: &'a mut Option<(PathBuf, JsRuntime)>, script: &PathBuf) -> Result<&'a mut JsRuntime, String> {
    if current.as_ref().map_or(true, |(p, _)| p != script) {
        *current = None;
        let source = std::fs::read_to_string(script).map_err(|e| format!("worker script {script:?}: {e}"))?;
        let mut rt = JsRuntime::new(RuntimeOptions { extensions: vec![entropy_worker::init_ops()], ..Default::default() });
        rt.op_state().borrow_mut().put(WorkerState { cache_root: PathBuf::new() });
        rt.execute_script("[entropy-worker bootstrap]", BOOTSTRAP).map_err(|e| e.to_string())?;
        rt.execute_script("[entropy-worker script]", source).map_err(|e| format!("worker script {script:?}: {e}"))?;
        *current = Some((script.clone(), rt));
    }
    Ok(&mut current.as_mut().unwrap().1)
}

fn run_job(current: &mut Option<(PathBuf, JsRuntime)>, job: &Job) -> Result<String, String> {
    let rt = isolate(current, &job.script)?;
    rt.op_state().borrow_mut().borrow_mut::<WorkerState>().cache_root = job.cache_root.clone();
    // The input is JSON, so it is a valid JavaScript expression as it stands.
    let code = format!("(() => {{ if (typeof globalThis.onJob !== 'function') throw new Error('worker script sets no onJob'); return JSON.stringify(globalThis.onJob({}) ?? null); }})()", job.input);
    let value = rt.execute_script("[entropy-worker job]", code).map_err(|e| e.to_string())?;
    let scope = &mut rt.handle_scope();
    let local = deno_core::v8::Local::new(scope, value);
    Ok(local.to_rust_string_lossy(scope))
}

fn run(shared: Arc<Shared>) {
    let mut current: Option<(PathBuf, JsRuntime)> = None;
    loop {
        let job = {
            let mut q = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if shared.shutdown.load(Ordering::SeqCst) { return; }
                if let Some(job) = q.pop_front() {
                    shared.running.lock().unwrap_or_else(|e| e.into_inner()).insert(job.id);
                    break job;
                }
                q = shared.wake.wait(q).unwrap_or_else(|e| e.into_inner());
            }
        };
        let outcome = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_job(&mut current, &job))) {
            Ok(Ok(json)) => Outcome::Done(json),
            // A failed job may leave its isolate in any state: start the next one fresh.
            Ok(Err(e)) => { current = None; Outcome::Failed(e) }
            Err(_) => { current = None; Outcome::Failed("worker panicked".into()) }
        };
        // Report and leave `running` under the `done` lock, so `poll` never sees neither.
        let mut done = shared.done.lock().unwrap_or_else(|e| e.into_inner());
        done.insert(job.id, outcome);
        shared.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&job.id);
    }
}

#[derive(Serialize)]
pub struct PollOut {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn pool(ctx: &mut AddonContext) -> Arc<WorkerPool> {
    ctx.worker_pool.get_or_insert_with(|| {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        Arc::new(WorkerPool::new((cores / 4).clamp(1, 2)))
    }).clone()
}

/// Queues `onJob(input)` of the worker script at `script` (a path, relative to the working
/// directory). Returns the job id.
#[op2(fast)]
pub fn op_worker_start(state: &mut OpState, #[string] script: String, #[string] input_json: String) -> Result<f64, JsErrorBox> {
    let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| JsErrorBox::generic("addon context unavailable"))?;
    if serde_json::from_str::<serde_json::Value>(&input_json).is_err() { return Err(JsErrorBox::generic("worker input must be JSON")); }
    let root = cache_root(ctx);
    Ok(pool(ctx).start(PathBuf::from(script), input_json, root) as f64)
}

#[op2]
#[serde]
pub fn op_worker_poll(state: &mut OpState, id: f64) -> PollOut {
    match state.try_borrow::<AddonContext>().and_then(|ctx| ctx.worker_pool.clone()) {
        Some(p) => p.poll(id as u64),
        None => PollOut { status: "unknown", result: None, error: None },
    }
}

#[op2(fast)]
pub fn op_worker_cancel(state: &mut OpState, id: f64) -> bool {
    state.try_borrow::<AddonContext>().and_then(|ctx| ctx.worker_pool.clone()).map_or(false, |p| p.cancel(id as u64))
}

/// Jobs queued or running.
#[op2(fast)]
pub fn op_worker_pending(state: &mut OpState) -> u32 {
    state.try_borrow::<AddonContext>().and_then(|ctx| ctx.worker_pool.clone()).map_or(0, |p| p.pending() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait(pool: &WorkerPool, id: u64) -> PollOut {
        let t = std::time::Instant::now();
        loop {
            let p = pool.poll(id);
            if p.status != "pending" { return p; }
            assert!(t.elapsed() < std::time::Duration::from_secs(60), "worker job stuck");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn runs_jobs_off_thread_and_writes_meshes_into_the_cache() {
        let dir = std::env::temp_dir().join(format!("entropy-worker-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("w.js");
        std::fs::write(&script, r#"
            let calls = 0;
            globalThis.onJob = (input) => {
                if (input.fail) throw new Error("asked to fail");
                calls++;
                // One triangle, 12 floats per vertex.
                const v = new Float32Array(36); v[12] = 1; v[25] = 1;
                EntropyWorker.MeshCache.put("worker-test", input.key, v, new Uint32Array([0, 1, 2]), JSON.stringify({ n: input.n }), null);
                return { doubled: input.n * 2, calls, main: typeof Entropy };
            };
        "#).unwrap();
        let root = dir.join("mesh-cache");
        let pool = WorkerPool::new(1);
        let a = pool.start(script.clone(), r#"{"n": 21, "key": "a"}"#.into(), root.clone());
        let b = pool.start(script.clone(), r#"{"fail": true}"#.into(), root.clone());
        let c = pool.start(script.clone(), r#"{"n": 1, "key": "c"}"#.into(), root.clone());
        let ra = wait(&pool, a);
        assert_eq!(ra.status, "done");
        let r = ra.result.unwrap();
        assert_eq!(r["doubled"], 42);
        assert_eq!(r["main"], "undefined", "workers see nothing of the addon runtime");
        let rb = wait(&pool, b);
        assert_eq!(rb.status, "failed");
        assert!(rb.error.unwrap().contains("asked to fail"));
        // A failed job resets its isolate; later jobs still run.
        assert_eq!(wait(&pool, c).status, "done");
        assert_eq!(pool.poll(a).status, "unknown", "a finished job is forgotten once read");
        let cache = cache_at(root);
        let mesh = cache.get("worker-test", "a").expect("the worker wrote the mesh");
        assert_eq!(mesh.indices, vec![0, 1, 2]);
        assert_eq!(mesh.meta, r#"{"n":21}"#);
        // Cancelling: a job queued behind a long one never runs.
        std::fs::write(dir.join("slow.js"), "globalThis.onJob = (ms) => { const t = Date.now(); while (Date.now() - t < ms) {} return ms; };").unwrap();
        let slow = pool.start(dir.join("slow.js"), "300".into(), dir.clone());
        let queued = pool.start(dir.join("slow.js"), "1".into(), dir.clone());
        assert!(pool.cancel(queued));
        assert_eq!(wait(&pool, slow).status, "done");
        assert_eq!(pool.poll(queued).status, "unknown");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real house worker (examples/studio-bundle/dist/qp_house_worker.js, built by
    /// `npm run build-house-worker`): a full Mesha house evaluated in a worker isolate lands in
    /// the mesh cache. Skipped when the bundle hasn't been built.
    #[test]
    fn evaluates_a_mesha_house_in_a_worker() {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/studio-bundle/dist/qp_house_worker.js");
        if !script.exists() { eprintln!("skipped: {script:?} not built"); return; }
        let dir = std::env::temp_dir().join(format!("entropy-house-worker-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pool = WorkerPool::new(1);
        let started = std::time::Instant::now();
        let id = pool.start(script, r#"{"values": {}, "lod0Key": "test|lod0", "lod1Key": "test|lod1"}"#.into(), dir.clone());
        let out = wait(&pool, id);
        assert_eq!(out.status, "done", "{:?}", out.error);
        let r = out.result.unwrap();
        assert!(r["lod0"].as_u64().unwrap() > 10_000, "a whole house: {r}");
        assert!(r["lod1"].as_u64().unwrap() < r["lod0"].as_u64().unwrap(), "LOD 1 leaves the inside out");
        let cache = cache_at(dir.clone());
        let t = std::time::Instant::now();
        while cache.get("quadplanet-houses", "test|lod1").is_none() {
            assert!(t.elapsed() < std::time::Duration::from_secs(120), "LOD 1 simplification never landed");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let lod0 = cache.get("quadplanet-houses", "test|lod0").expect("LOD 0 written");
        assert_eq!(lod0.indices.len() / 3, r["lod0"].as_u64().unwrap() as usize);
        eprintln!("house evaluated off-thread in {:?}: {r}", started.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
