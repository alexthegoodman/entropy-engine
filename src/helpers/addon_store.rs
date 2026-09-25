//! A small document store each addon owns under the app's data folder: `<data_dir>/<addon>/...`.
//!
//! `Entropy.IO.save`/`load` give an addon exactly one JSON file. An app that manages many documents
//! (the DAW's song library and its version history, say) needs to read, write, list and remove
//! files by name, and needs a write that cannot leave a half-written file behind when the process
//! dies mid-save. This is that, and nothing more:
//!
//! - Every path is relative to the addon's own folder and made of plain name segments
//!   (`[A-Za-z0-9_.-]`, not starting with a dot), so an addon cannot reach outside its folder,
//!   into another addon's folder, or onto a temporary file of an in-flight write.
//! - Writes go to a hidden temporary file beside the target, are flushed to disk, then renamed
//!   over it. Readers see the old file or the new one, never a mix.
//! - The store only exists where the app set a data folder (`EntropyApp::with_data_dir`); there is
//!   deliberately no fallback to the old project-id folders.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_SEGMENTS: usize = 8;
const MAX_SEGMENT_LEN: usize = 128;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreEntry {
    pub name: String,
    pub is_dir: bool,
    /// Bytes; 0 for a folder.
    pub size: u64,
    /// Last modification, in milliseconds since the Unix epoch (0 if the OS does not say).
    pub modified_ms: f64,
}

fn valid_segment(segment: &str, allow_space: bool) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_SEGMENT_LEN
        && !segment.starts_with('.')
        && segment.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') || (allow_space && c == ' '))
}

/// The folder an addon's store lives in. Addon names come from `Entropy.Addon.register` and may
/// hold spaces ("Canvas Surfaces"), so spaces are allowed here but not in the paths beneath it.
pub fn addon_root(data_dir: &Path, addon_name: &str) -> Result<PathBuf, String> {
    if !valid_segment(addon_name, true) {
        return Err(format!("\"{addon_name}\" cannot be used as a storage folder name"));
    }
    Ok(data_dir.join(addon_name))
}

/// Resolves `path` (forward slashes, relative) inside `root`. The empty path is the root itself,
/// which is only accepted where `allow_root` is set (listing it is fine; deleting it is not).
pub fn resolve(root: &Path, path: &str, allow_root: bool) -> Result<PathBuf, String> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return if allow_root { Ok(root.to_path_buf()) } else { Err("a file name is required".to_string()) };
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    if segments.len() > MAX_SEGMENTS {
        return Err(format!("\"{path}\" is nested too deeply"));
    }
    let mut out = root.to_path_buf();
    for segment in segments {
        if !valid_segment(segment, false) {
            return Err(format!("\"{path}\" is not a valid storage path (use letters, digits, '_', '-' and '.', and no leading dots)"));
        }
        out.push(segment);
    }
    Ok(out)
}

/// The file's text, or `None` if there is no such file.
pub fn read(root: &Path, path: &str) -> Result<Option<String>, String> {
    let file = resolve(root, path, false)?;
    match std::fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {path}: {e}")),
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes `data` to `path` so that the file is either entirely the old content or entirely the new
/// one, whatever happens part-way. Missing parent folders are created.
pub fn write(root: &Path, path: &str, data: &str) -> Result<(), String> {
    let file = resolve(root, path, false)?;
    write_atomic(&file, data.as_bytes()).map_err(|e| format!("could not write {path}: {e}"))
}

/// The atomic replace behind [`write`], also used for `Entropy.IO.save`'s single file. The
/// temporary name starts with a dot, so [`list`] never shows it and [`resolve`] never reaches it.
pub fn write_atomic(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = file.parent().ok_or_else(|| std::io::Error::other("no parent folder"))?;
    std::fs::create_dir_all(dir)?;
    let name = file.file_name().ok_or_else(|| std::io::Error::other("no file name"))?.to_string_lossy();
    let temp = dir.join(format!(".{name}.{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut out = std::fs::File::create(&temp)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        drop(out);
        // Replaces an existing file on every platform std supports (MOVEFILE_REPLACE_EXISTING on Windows).
        std::fs::rename(&temp, file)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// What is directly inside the folder `path`, folders first, then files, each by name. A folder that
/// does not exist lists as empty: a new addon has nothing stored yet, which is not an error.
pub fn list(root: &Path, path: &str) -> Result<Vec<StoreEntry>, String> {
    let dir = resolve(root, path, true)?;
    let read = match std::fs::read_dir(&dir) {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not list {path}: {e}")),
    };
    let mut entries: Vec<StoreEntry> = read
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_segment(&name, false) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            Some(StoreEntry { name, is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() }, modified_ms })
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

/// Removes a file, or a folder with everything in it. Answers whether anything was there.
pub fn remove(root: &Path, path: &str) -> Result<bool, String> {
    let target = resolve(root, path, false)?;
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("could not remove {path}: {e}")),
    };
    let result = if meta.is_dir() { std::fs::remove_dir_all(&target) } else { std::fs::remove_file(&target) };
    result.map(|_| true).map_err(|e| format!("could not remove {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("entropy-addon-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn round_trips_nested_files_and_lists_folders_first() {
        let root = temp_root("roundtrip");
        write(&root, "songs/a.json", "{\"a\":1}").unwrap();
        write(&root, "songs/b.json", "{}").unwrap();
        write(&root, "versions/a/v1.json", "[]").unwrap();
        assert_eq!(read(&root, "songs/a.json").unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(read(&root, "songs/missing.json").unwrap(), None);

        let top: Vec<_> = list(&root, "").unwrap().into_iter().map(|e| (e.name, e.is_dir)).collect();
        assert_eq!(top, vec![("songs".to_string(), true), ("versions".to_string(), true)]);
        let songs = list(&root, "songs").unwrap();
        assert_eq!(songs.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["a.json", "b.json"]);
        assert_eq!(songs[0].size, 7);
        assert!(songs[0].modified_ms > 0.0);
        assert!(list(&root, "nothing/here").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn overwrites_in_place_and_leaves_no_temporary_files() {
        let root = temp_root("overwrite");
        for i in 0..20 {
            write(&root, "doc.json", &format!("{{\"n\":{i}}}")).unwrap();
        }
        assert_eq!(read(&root, "doc.json").unwrap().as_deref(), Some("{\"n\":19}"));
        let on_disk: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(on_disk.len(), 1, "only the document itself, no leftover temp files: {on_disk:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn removes_files_and_whole_folders() {
        let root = temp_root("remove");
        write(&root, "versions/a/1.json", "1").unwrap();
        write(&root, "versions/a/2.json", "2").unwrap();
        write(&root, "keep.json", "k").unwrap();
        assert!(remove(&root, "versions/a/1.json").unwrap());
        assert!(!remove(&root, "versions/a/1.json").unwrap(), "already gone");
        assert!(remove(&root, "versions/a").unwrap());
        assert!(list(&root, "versions").unwrap().is_empty());
        assert!(remove(&root, "").is_err(), "the store's own folder cannot be removed");
        assert_eq!(read(&root, "keep.json").unwrap().as_deref(), Some("k"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_paths_that_leave_the_store_or_touch_hidden_files() {
        let root = temp_root("escape");
        for bad in ["../x.json", "a/../../x.json", "..", ".hidden", "a/.tmp", "a\\b.json", "C:/x.json", "a b.json", "a//b.json", "~/x", "a/b/c/d/e/f/g/h/i.json"] {
            assert!(write(&root, bad, "x").is_err(), "{bad} should be refused");
            assert!(read(&root, bad).is_err(), "{bad} should be refused");
        }
        assert!(resolve(&root, "/songs/a.json/", false).unwrap().ends_with("songs/a.json"));
        assert!(addon_root(Path::new("data"), "Canvas Surfaces").is_ok());
        assert!(addon_root(Path::new("data"), "../evil").is_err());
        assert!(addon_root(Path::new("data"), "").is_err());
    }

    #[test]
    fn list_hides_in_flight_temporary_files() {
        let root = temp_root("hidden");
        write(&root, "a.json", "1").unwrap();
        std::fs::write(root.join(".a.json.1-1.tmp"), "partial").unwrap();
        assert_eq!(list(&root, "").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
