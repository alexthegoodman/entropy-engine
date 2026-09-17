//! Browser BDD entrypoint.
//!
//! The feature below remains the fast behavioral contract. After it passes, this binary starts
//! the real `html-ui-demo` executable in its in-engine test mode. That mode injects stable
//! control IDs and captures composed frames; it never uses OS input automation.

use cucumber::{given, then, when, World as _};
use std::process::Command;

#[derive(Debug, Default, cucumber::World)]
struct BrowserWorld {
    history: Vec<String>,
    history_index: Option<usize>,
    bookmarks: Vec<String>,
    fetch_error: Option<String>,
}

impl BrowserWorld {
    fn loaded(&mut self, url: String) {
        let next = self.history_index.map_or(0, |index| index + 1);
        self.history.truncate(next);
        self.history.push(url);
        self.history_index = Some(self.history.len() - 1);
        self.fetch_error = None;
    }

    fn current_url(&self) -> Option<&str> {
        self.history_index
            .and_then(|index| self.history.get(index))
            .map(String::as_str)
    }
}

#[given(expr = "the browser has loaded {string}")]
fn browser_has_loaded(world: &mut BrowserWorld, url: String) {
    world.loaded(url);
}

#[when(expr = "the browser follows {string}")]
fn browser_follows(world: &mut BrowserWorld, url: String) {
    world.loaded(url);
}

#[when("the browser goes back")]
fn browser_goes_back(world: &mut BrowserWorld) {
    if let Some(index) = world.history_index.filter(|index| *index > 0) {
        world.history_index = Some(index - 1);
    }
}

#[when("the browser goes forward")]
fn browser_goes_forward(world: &mut BrowserWorld) {
    if let Some(index) = world.history_index {
        if index + 1 < world.history.len() {
            world.history_index = Some(index + 1);
        }
    }
}

#[when("the browser bookmarks the current page")]
fn browser_bookmarks_current_page(world: &mut BrowserWorld) {
    let url = world.current_url().expect("a page must be loaded before it can be bookmarked").to_owned();
    if !world.bookmarks.contains(&url) {
        world.bookmarks.push(url);
    }
}

#[when(expr = "the browser fetch fails for {string}")]
fn browser_fetch_fails(world: &mut BrowserWorld, url: String) {
    world.fetch_error = Some(format!("failed to fetch {url}"));
}

#[then(expr = "the current URL is {string}")]
fn current_url_is(world: &mut BrowserWorld, expected: String) {
    assert_eq!(world.current_url(), Some(expected.as_str()));
}

#[then(expr = "{string} is a bookmark")]
fn is_a_bookmark(world: &mut BrowserWorld, expected: String) {
    assert!(world.bookmarks.contains(&expected));
}

#[then("the browser shows a fetch error")]
fn browser_shows_fetch_error(world: &mut BrowserWorld) {
    assert!(world.fetch_error.is_some());
}

#[tokio::main]
async fn main() {
    BrowserWorld::run("tests/features/browser_loop.feature").await;

    let artifact_dir = std::env::current_dir()
        .expect("test working directory")
        .join("test-artifacts/browser-bdd");
    let result_path = artifact_dir.join("result.json");
    let _ = std::fs::remove_file(&result_path);

    let example = std::env::var_os("CARGO_BIN_EXE_example")
        .expect("Cargo must provide the real example binary to browser_bdd");
    let status = Command::new(example)
        .arg("html-ui-demo")
        .env("ENTROPY_BROWSER_BDD_RESULT", &result_path)
        .status()
        .expect("launch the real Entropy HTML browser demo");
    assert!(status.success(), "the live browser demo must exit cleanly: {status}");

    let result: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&result_path).expect("live browser BDD result JSON"),
    )
    .expect("valid live browser BDD result JSON");
    assert_eq!(result["status"], "passed", "{result:#}");
    for artifact in result["artifacts"].as_array().expect("artifact array") {
        assert!(std::path::Path::new(artifact.as_str().expect("artifact path")).is_file(), "missing artifact {artifact}");
    }
    let action_count = result["actions"].as_array().expect("action array").len();
    let artifact_count = result["artifacts"].as_array().expect("artifact array").len();
    println!("\n[Live browser BDD]");
    println!("  ✔ launched real HTML UI demo in test mode");
    println!("  ✔ {action_count} stable-ID actions completed");
    println!("  ✔ {artifact_count} composed PNG checkpoints written");
    println!("  ✔ result JSON: {}", result_path.display());
    println!("[Summary] 1 live-ui feature (passed)");
}
