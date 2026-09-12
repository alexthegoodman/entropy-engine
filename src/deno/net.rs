//! Blocking network fetches for addon-facing ops (`op_http_get_text`, and the `<img>` fetch in
//! `html_layout.rs`). Everything here only ever returns raw bytes/text to the caller - nothing
//! in this module parses or executes anything fetched. See the security note in
//! `html_layout.rs` next to where `<script>` content is skipped: that boundary (never execute
//! remote content) is what makes it safe for these functions to have no consent gate at all.
//!
//! Run on a plain `std::thread`, not `reqwest::blocking` directly, because the engine's `main`
//! already runs inside a Tokio runtime (see `src/bin/example.rs`'s `#[tokio::main]`), and
//! `reqwest::blocking` panics if constructed from within one.

pub fn blocking_fetch_text(url: &str) -> Result<String, String> {
    let url = url.to_string();
    std::thread::spawn(move || reqwest::blocking::get(&url).and_then(|r| r.error_for_status()).and_then(|r| r.text()))
        .join()
        .map_err(|_| "fetch thread panicked".to_string())?
        .map_err(|e| e.to_string())
}

pub fn blocking_fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let url = url.to_string();
    std::thread::spawn(move || reqwest::blocking::get(&url).and_then(|r| r.error_for_status()).and_then(|r| r.bytes()))
        .join()
        .map_err(|_| "fetch thread panicked".to_string())?
        .map_err(|e| e.to_string())
        .map(|b| b.to_vec())
}
