use std::path::PathBuf;

/// The public embedding entrypoint for third-party apps built on `entropy-engine`.
///
/// ```no_run
/// entropy_engine::EntropyApp::new()
///     .with_bundle("dist/bundle.js")
///     .run()
///     .expect("Couldn't run app");
/// ```
///
/// Unlike [`crate::startup::run`] (which launches Entropy Studio, the reference editor app),
/// `EntropyApp` never shows Studio's project picker and has no "project" concept — addons
/// persist their own data under a directory you control via [`Self::with_data_dir`].
pub struct EntropyApp {
    start_addon: Option<String>,
    bundle_path: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    capture_cursor: bool,
    window_title: Option<String>,
    window_size: Option<(f64, f64)>,
    window_icon: Option<PathBuf>,
    resizable: Option<bool>,
    hot_reload: bool,
    art_assets_project_id: Option<String>,
}

impl EntropyApp {
    pub fn new() -> Self {
        Self {
            start_addon: None,
            bundle_path: None,
            data_dir: None,
            capture_cursor: false,
            window_title: None,
            window_size: None,
            window_icon: None,
            resizable: None,
            hot_reload: false,
            art_assets_project_id: None,
        }
    }

    /// Path to your TypeScript app's bundled entrypoint (e.g. the output of
    /// `deno bundle src/index.ts > dist/bundle.js`). Loaded at startup instead of Entropy
    /// Studio's built-in addon bundle.
    pub fn with_bundle(mut self, path: impl Into<PathBuf>) -> Self {
        self.bundle_path = Some(path.into());
        self
    }

    /// Directory your addons should save/load their own data under (via `Entropy.Addon.saveData`/
    /// `loadData`, `Entropy.Script.read`/`write`). Defaults to `./data` if not set. Addons choose
    /// their own filenames within it (e.g. `projects.json`, `project123.json`, `addon123.json`).
    pub fn with_data_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.data_dir = Some(path.into());
        self
    }

    /// Name of an already-registered game/scene to auto-start (looked up via
    /// `Entropy.Composer.getGame(name)` once your bundle has registered it).
    pub fn with_start_addon(mut self, name: impl Into<String>) -> Self {
        self.start_addon = Some(name.into());
        self
    }

    /// Go borderless-fullscreen and hide/lock the cursor on startup, like a typical game.
    /// Off by default — most apps (tools, DAWs, editors) want a normal windowed cursor.
    pub fn capture_cursor(mut self, enabled: bool) -> Self {
        self.capture_cursor = enabled;
        self
    }

    /// Set the OS window title. Defaults to "Entropy Engine" if not set - every embedder will
    /// want their own app name here.
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.window_title = Some(title.into());
        self
    }

    /// Set the initial window size in logical pixels. Defaults to 1200x768.
    pub fn with_window_size(mut self, width: f64, height: f64) -> Self {
        self.window_size = Some((width, height));
        self
    }

    /// Set the OS window/taskbar icon from an image file (PNG, ICO, etc - anything the `image`
    /// crate can decode). A bad path is logged at startup and the app continues without a
    /// custom icon rather than aborting over a cosmetic asset.
    pub fn with_window_icon(mut self, path: impl Into<PathBuf>) -> Self {
        self.window_icon = Some(path.into());
        self
    }

    /// Whether the user can resize the window. Defaults to `true`.
    pub fn with_resizable(mut self, resizable: bool) -> Self {
        self.resizable = Some(resizable);
        self
    }

    /// Watch `with_bundle`'s file for changes and reload it into the running addon engine in
    /// place - engine-side state (GPU buffers/pipelines/meshes reachable by a stable id) is
    /// preserved rather than reset, so e.g. a running simulation keeps its accumulated state
    /// across a reload. Off by default, and only takes effect when a bundle path is set (there
    /// is nothing to watch for Studio's compiled-in bundle). Reload itself is triggered by
    /// re-running `deno bundle` to overwrite that file - this does not bundle for you.
    pub fn with_hot_reload(mut self, enabled: bool) -> Self {
        self.hot_reload = enabled;
        self
    }

    /// Lets `Entropy.Model.load`/`Entropy.Texture.load` resolve art assets for a bare
    /// `EntropyApp` (they're otherwise Studio-project-only - both hard-require a project id
    /// internally, since they read from `<CommonOS sync dir>/midpoint/projects/<id>/models|textures/<file>`,
    /// the MidPoint asset-project convention). This is *not* Entropy Studio's project system -
    /// nothing else about "no project concept" (see this struct's docs) changes - it only unlocks
    /// asset path resolution for addons that want to load real `.glb`/texture files instead of
    /// hand-authored geometry. `id` is a MidPoint project id (the folder name under
    /// `midpoint/projects/`), not anything Entropy-specific.
    pub fn with_art_assets_project(mut self, id: impl Into<String>) -> Self {
        self.art_assets_project_id = Some(id.into());
        self
    }

    pub fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let data_dir = self.data_dir.unwrap_or_else(|| PathBuf::from("./data"));

        crate::startup::run_with_config(crate::startup::RunConfig {
            game_mode: true,
            project_id: self.art_assets_project_id,
            start_addon: self.start_addon,
            bundle_path: self.bundle_path,
            hot_reload: self.hot_reload,
            data_dir: Some(data_dir),
            capture_cursor: self.capture_cursor,
            window: crate::startup::WindowConfig {
                title: self.window_title,
                size: self.window_size,
                icon_path: self.window_icon,
                resizable: self.resizable,
            },
        })
    }
}

impl Default for EntropyApp {
    fn default() -> Self {
        Self::new()
    }
}
