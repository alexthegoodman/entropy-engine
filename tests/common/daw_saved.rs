//! Where the DAW's open song is on disk, for the live suites: the song library's index
//! (`<data>/DAW/library.json`) names the open song, whose file is `<data>/DAW/songs/<id>.json`.
//! The old single `<data>/DAW.json` is no longer written (see daw_library.ts).

use std::{fs, path::Path};

/// The project of the song the DAW had open, exactly as it saved it.
pub fn open_song(data: &Path) -> serde_json::Value {
    let library = data.join("DAW").join("library.json");
    let index: serde_json::Value = serde_json::from_slice(&fs::read(&library).expect("the DAW saved its song library")).expect("valid library.json");
    let id = index["currentSongId"].as_str().expect("library.json names the open song");
    let song = data.join("DAW").join("songs").join(format!("{id}.json"));
    let doc: serde_json::Value = serde_json::from_slice(&fs::read(&song).expect("the open song's file exists")).expect("valid song file");
    assert_eq!(doc["format"], "entropy-daw-song", "{} is not a DAW song file", song.display());
    doc["project"].clone()
}
