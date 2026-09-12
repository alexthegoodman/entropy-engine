# Security

This is mostly if we go with the web browser for high performance apps.

**Ultimately, we want to sell code-signing certs for trusted publishers, and make untrusted publishers look scary.**

This is how we will establish the trust of an install, with the convenience of instant, always updated experience.

It also provides a bonus reward for those who purchase the certs, granting them instant ROI. Disadvantaged people may be enabled
to submit an app for review and a free cert depending on certain conditions in the future, to level the playing field.

## High concern — effectively unscoped, any addon can call today

Net.getText(url) — arbitrary URL, no allowlist, no per-addon declaration. Covered already, but it's the standout: exfiltration and internal-network probing (http://169.254.169.254/..., LAN scanning) both work through this with zero other capability needed.
Scripts.list / read / write(filename, content) — this reads/writes arbitrary-named files under whatever scripts directory backs it, and unlike IO.save there's no mention of a fixed folder constraint in the type comments. If it's addon-scoped (each addon only sees its own scripts dir) that's fine; if it's a shared directory across all addons, one addon can read or overwrite another addon's source, which is a privilege-escalation path (addon A rewrites addon B's script, waits for B to run with B's permissions).
IO.load() / IO.pickAndImportModel() — IO.save/saveImage are folder-scoped per your description, but load() has no argument shown (reads from... a picker? a fixed path?) and pickAndImportModel opens a native file picker. A file picker itself is low-risk (user drives it), but confirm load() isn't an arbitrary-path read — the type signature (load: () => any) gives no scoping guarantee the way saveImage implies one.

## Medium concern — mediated, but the mediation is coarse or stateful in ways worth checking

Compute.dispatch / Pipeline.createCompute with raw shaderSource: string — you're not exposing raw GPU queues, but you are compiling and running arbitrary WGSL supplied by an addon. WGSL itself can't do arbitrary memory access outside its bound resources (that's the whole point of WebGPU's safety model, which wgpu implements), so this is probably fine — but worth explicitly confirming wgpu's validation layer is always in the loop for addon-supplied shaders, not just for setPointLightShader's documented error-scope pattern. Right now only the lighting shader path has a stated graceful-fallback; generic Pipeline.createCompute from an addon might not have the same "validate or reject, don't crash" guarantee.
Buffer.create with size: number — no visible upper bound. An addon (or a malicious remote one) requesting huge allocations repeatedly is a DoS vector against the host process, not a sandbox escape, but worth a cap.
Video.export writes to outputPath: string — is that path addon-scoped or arbitrary? If arbitrary, it's a targeted-write primitive (unlike IO.save's implied folder scoping) — e.g., overwriting a specific file elsewhere on disk under the guise of "exporting a video."

## Lower concern, just flag for awareness

GameState.save/load(key, data) — presumably scoped by addon namespace already (typical for this pattern), but confirm keys can't collide/overwrite across addons.
Multithreading via Compute/Yumon.brain.sleep(id, epochs) — you noted this is API-mediated, not raw thread exposure, which is the right shape; main residual risk is just resource exhaustion (an addon requesting huge training epochs or dispatch loops), which is a quota/rate-limit problem, not a sandboxing one.

My actual priority order for you to address:

Net.getText — add per-addon domain allowlist or manifest-declared network capability.
Confirm Scripts.* and IO.load are hard-scoped to the calling addon's own directory, not a shared or arbitrary path — this is the one place "looks scoped" needs verification rather than assumption.
Confirm Video.export's outputPath is sandboxed the same way IO.save is.
Extend the validate-or-fallback (error-scope) pattern from setPointLightShader to Pipeline.createCompute/general shader compilation, if it isn't already uniform.
Add basic size/rate caps on Buffer.create and dispatch loops as a DoS guard, lowest priority of the five.