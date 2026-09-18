# Vendored crates

## vst3-host 0.9.0

Copied unmodified from crates.io, then patched in two places (each marked `ENTROPY PATCH`):

1. `src/internal/plugin_impl.rs`, `open_editor`: a `getSize` that fails *before* the view is attached
   no longer aborts opening the editor. Native Instruments' Massive and Maschine 3 both do this
   (`Failed to get view size`), and neither editor could open without the change. pluginterfaces
   documents `getSize` as returning the size of the view's *platform representation*, which `attached`
   creates, so the plugins are within their rights; the host has to tolerate it.
2. `src/window.rs`, Windows `open`: once the editor is attached, the window is resized to the size the
   attached view reports, since the size used to create the window came from a throwaway view.

Wired in through `[patch.crates-io]` in `entropy-engine/Cargo.toml`. Drop this directory and that
patch entry once an upstream release contains an equivalent fix.
