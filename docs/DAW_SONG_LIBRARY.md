# DAW song library and version history

The DAW keeps any number of songs. Each song saves as you work and keeps a version history you can restore from. The old single `DAW.json` is no longer written.

## Using it

- **The song bar** at the top of the DAW shows the open song, whether it is saved (`Saved just now`, `Saving...`, or `Not saved: <reason>` in place of silence), and three buttons: **Songs**, **History** and **Save version**.
- **Songs** (Ctrl+O) is the library: search, sort (last edited, name, date created), and a list that scrolls, however many songs there are. Select a song to **Open**, **Rename**, **Duplicate** or **Delete** it. **New song from** creates a song from a blank song, the demo, or one of the sample songs. A new song never replaces the one you are working on.
- **Nothing asks you to save.** The open song is written on every edit, so opening another song needs no prompt, and nothing is lost.
- **Delete** moves a song to **Recently deleted** and offers **Undo**. Deleted songs can be restored for 30 days, then they are removed for good. **Delete forever** and **Empty Recently deleted** need a second click. Deleting the open song opens your most recent other song, or a new blank one.
- **History** lists the open song's versions by day. Select one to see what restoring it would change (tempo, length, tracks it brings back or removes, clip count), then:
  - **Restore this version.** The song as it is now is kept as a "Before restoring" version first, and the message offers **Undo**.
  - **Open as new song** leaves the original alone.
  - **Keep and name** / **Rename** gives it a name, which also keeps it from being thinned out.
  - **Delete** (second click to confirm).
- **Ctrl+S** or **Save version** keeps a version now. If nothing changed since the last version, it says so and keeps nothing. Type a name first to save a named version.

## When versions are kept, and when they are thrown out

A version is kept:

- every 10 minutes while the song is changing (an idle song keeps none);
- when a song is opened, and when you leave a song that changed since its last version;
- before a restore;
- whenever you press Ctrl+S or **Save version**;
- once, labelled "Imported from the previous DAW save", when an old `DAW.json` becomes your first song.

An automatic version that would match the newest one exactly is never kept.

Automatic versions thin out as they age, like Time Machine: every version from the last hour, the newest of each hour for the last day, of each day for the last 30 days, and of each week after that. There is a hard limit of 100 automatic versions per song. The newest automatic version is always kept. Named versions are never thinned; they stay until you delete them.

## On disk

Everything lives under the app's data folder, in the DAW's own store folder (`Entropy.IO.store`, see the root README):

```
<data_dir>/DAW/library.json                 index: songs, names, dates, summary, which song is open
<data_dir>/DAW/songs/<songId>.json          { format: "entropy-daw-song", version: 1, name, savedAt, project }
<data_dir>/DAW/versions/<songId>/index.json the song's version list
<data_dir>/DAW/versions/<songId>/<id>.json  { format: "entropy-daw-version", version: 1, entry, project }
```

- Every write is atomic: a temporary file is written, flushed and renamed over the old one. A crash leaves either the old file or the new one, never a half-written file.
- The song files are the source of truth. If `library.json` is lost or damaged, it is rebuilt from them. A song file the index does not know about (from an interrupted session) is added back.
- If a song file cannot be read, the song opens from its newest readable version, and the DAW says so.
- **Upgrading:** on the first start with the library, an existing `DAW.json` is imported as a song called "My song". The old file is left untouched.
- An app with no data folder (`EntropyApp::with_data_dir` never called) has no store. The library then lasts for the session only, and the open song still goes to `IO.save`, as before. The song bar says "Song library unavailable: only this song is kept".

## For the assistant

The `daw_songs` tool lists, opens, creates (from any template), renames, duplicates and deletes songs. It also lists, saves and restores versions. `daw_get_state` includes the open song's id and name.

## Code

| File | What it holds |
| --- | --- |
| `examples/studio-bundle/src/apps/daw_library.ts` | The library and version history, with no UI: the file layout, retention (`versionsToPrune`), recovery, and naming. |
| `examples/studio-bundle/src/apps/daw_synth_addon.ts` | Wiring: `writeProject`, `openSong`, `restoreVersion`, the song bar, the Songs and History windows, the shortcuts, and the `daw_songs` tool. |
| `src/helpers/addon_store.rs`, `op_addon_store_*` in `src/deno/addon_ops.rs` | The engine store: path rules and atomic writes. |

Tests: `tests/daw_library.test.ts` (model), `tests/daw_songs_bdd.test.ts` with `tests/features/daw_songs.feature` (the production addon's UI callbacks), `src/helpers/addon_store.rs` unit tests, `tests/addon_store_js.rs` (the store through V8), and `tests/daw_songs_headless.rs` (the bundled DAW starting against a real folder; needs `npm run build-daw`).
