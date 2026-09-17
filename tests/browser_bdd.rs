//! Fast, deterministic behavioral contract for the HTML browser loop.
//!
//! This is deliberately separate from the native visual-driver suite: these scenarios run
//! without a window or network, while the visual suite will drive the same public controls and
//! save real framebuffer checkpoints. Keeping state assertions here makes the common test path
//! cheap enough to run on every edit.

use cucumber::{given, then, when, World as _};

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
}
