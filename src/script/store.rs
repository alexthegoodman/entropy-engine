//! An app's document store (`IO.store` in scripts): small text files by relative path. Natively
//! they are files under the app's data directory, written atomically; in a browser they are
//! `localStorage` entries under the app's own prefix. Paths are checked the same way on both, so
//! a script cannot step outside its store.

#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Store {
    #[cfg(not(target_arch = "wasm32"))]
    dir: Option<PathBuf>,
    #[cfg(target_arch = "wasm32")]
    prefix: String,
}

/// A relative path of plain names: no `..`, no root, no backslashes, nothing empty.
pub fn check_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() || path.len() > 256 {
        return Err("store path must be 1 to 256 characters".into());
    }
    if path.starts_with('/') || path.contains('\\') || path.contains(':') {
        return Err(format!("store path {path:?} must be relative"));
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("store path {path:?} has an empty, '.' or '..' part"));
        }
        if !part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ')) {
            return Err(format!("store path {path:?} may only use letters, digits, '-', '_', '.' and spaces"));
        }
    }
    Ok(path.to_string())
}

impl Store {
    /// `name` keeps apps apart: a folder natively, a key prefix in the browser.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(data_dir: Option<PathBuf>, name: &str) -> Self {
        Self { dir: data_dir.map(|d| d.join(sanitize(name))) }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn new(name: &str) -> Self {
        Self { prefix: format!("entropy:{}:", sanitize(name)) }
    }

    /// A store that keeps nothing (tests).
    pub fn none() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        return Self { dir: None };
        #[cfg(target_arch = "wasm32")]
        return Self { prefix: String::new() };
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn read(&self, path: &str) -> Result<Option<String>, String> {
        let path = check_path(path)?;
        let Some(dir) = &self.dir else { return Ok(None) };
        match std::fs::read_to_string(dir.join(path)) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn write(&self, path: &str, content: &str) -> Result<(), String> {
        let path = check_path(path)?;
        let Some(dir) = &self.dir else { return Err("this app has no data folder".into()) };
        let full = dir.join(&path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = full.with_extension("tmp-write");
        std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &full).map_err(|e| e.to_string())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn remove(&self, path: &str) -> Result<bool, String> {
        let path = check_path(path)?;
        let Some(dir) = &self.dir else { return Ok(false) };
        match std::fs::remove_file(dir.join(path)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn storage(&self) -> Option<web_sys::Storage> {
        if self.prefix.is_empty() {
            return None;
        }
        web_sys::window()?.local_storage().ok().flatten()
    }

    #[cfg(target_arch = "wasm32")]
    pub fn read(&self, path: &str) -> Result<Option<String>, String> {
        let path = check_path(path)?;
        let Some(s) = self.storage() else { return Ok(None) };
        s.get_item(&format!("{}{path}", self.prefix)).map_err(|_| "localStorage is not available".to_string())
    }

    #[cfg(target_arch = "wasm32")]
    pub fn write(&self, path: &str, content: &str) -> Result<(), String> {
        let path = check_path(path)?;
        let Some(s) = self.storage() else { return Err("localStorage is not available".into()) };
        s.set_item(&format!("{}{path}", self.prefix), content).map_err(|_| "localStorage refused the write (full?)".to_string())
    }

    #[cfg(target_arch = "wasm32")]
    pub fn remove(&self, path: &str) -> Result<bool, String> {
        let path = check_path(path)?;
        let Some(s) = self.storage() else { return Ok(false) };
        let key = format!("{}{path}", self.prefix);
        let had = s.get_item(&key).ok().flatten().is_some();
        s.remove_item(&key).map_err(|_| "localStorage is not available".to_string())?;
        Ok(had)
    }
}

fn sanitize(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' }).collect();
    if s.is_empty() { "app".into() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_store() {
        assert!(check_path("campaign.json").is_ok());
        assert!(check_path("saves/slot 1.json").is_ok());
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "c:\\x", "a\\b", "./a"] {
            assert!(check_path(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
