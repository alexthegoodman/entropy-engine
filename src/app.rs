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
}

impl EntropyApp {
    pub fn new() -> Self {
        Self {
            start_addon: None,
            bundle_path: None,
            data_dir: None,
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

    pub fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let data_dir = self.data_dir.unwrap_or_else(|| PathBuf::from("./data"));

        crate::startup::run_with_config(crate::startup::RunConfig {
            game_mode: true,
            project_id: None,
            start_addon: self.start_addon,
            bundle_path: self.bundle_path,
            data_dir: Some(data_dir),
        })
    }
}

impl Default for EntropyApp {
    fn default() -> Self {
        Self::new()
    }
}
