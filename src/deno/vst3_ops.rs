//! `Entropy.Vst3` ops: thin JSON-in/JSON-out wrappers over `crate::audio::vst3`. Every failure is
//! reported as `{ ok: false, error }` rather than thrown, since a missing or misbehaving third-party
//! plugin is an ordinary runtime condition an addon UI should show, not a script crash.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;

// `#[op2]` treats a type literally named `Value` as a V8 value, so alias serde_json's.
type Json = serde_json::Value;

use crate::audio::vst3;
use crate::deno::addon_ops::AddonContext;

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

#[op2]
#[serde]
pub fn op_vst3_scan(refresh: bool) -> Json {
    let (plugins, skipped) = vst3::cached_scan(refresh);
    json!({ "plugins": plugins, "skipped": skipped })
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Vst3LoadConfig {
    pub track_id: String,
    pub path: String,
    /// Base64 of a blob from a previous `saveState`/`pollState`.
    pub state: Option<String>,
}

/// Loads a plugin for a track's bus. The track's bus must already exist (`Audio.ensureTrackBus`),
/// since the plugin's audio is a source in that bus's mixer. Blocks the calling frame for as long
/// as the plugin takes to initialise (Maschine 3: ~1.2s, Vital/Massive: ~0.25s on the dev machine).
#[op2]
#[serde]
pub fn op_vst3_load(state: &mut OpState, #[serde] config: Vst3LoadConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let audio_engine = ctx.audio_engine.clone();

    let restored = match config.state.as_deref().filter(|s| !s.is_empty()) {
        Some(b64) => match B64.decode(b64) {
            Ok(bytes) => Some(bytes),
            Err(e) => return err(format!("state is not valid base64: {e}")),
        },
        None => None,
    };

    let started = std::time::Instant::now();
    let (instrument, source) = match vst3::load_instrument(std::path::Path::new(&config.path), restored.as_deref()) {
        Ok(pair) => pair,
        Err(e) => return err(e),
    };
    let (name, vendor) = (instrument.info.name.clone(), instrument.info.vendor.clone());
    let has_editor = instrument.has_editor();
    let parameter_count = instrument.parameter_count();

    // Drop any previous instrument for this track *before* the new source joins the mixer.
    vst3::remove_instrument(&config.track_id);
    if !audio_engine.add_track_source(&config.track_id, source) {
        instrument.unload();
        return err("this track has no mixing bus yet - call Audio.ensureTrackBus first");
    }
    vst3::insert_instrument(&config.track_id, instrument);

    json!({
        "ok": true,
        "name": name,
        "vendor": vendor,
        "hasEditor": has_editor,
        "parameterCount": parameter_count,
        "loadMs": started.elapsed().as_millis() as u64,
    })
}

#[op2(fast)]
pub fn op_vst3_unload(#[string] track_id: String) {
    vst3::remove_instrument(&track_id);
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Vst3NoteConfig {
    pub track_id: String,
    /// 0-127.
    pub note: u8,
    /// 0-127.
    pub velocity: u8,
    /// Seconds until the matching note-off.
    pub duration: f64,
    /// 0-15 (MIDI channel 1-16).
    pub channel: u8,
}

#[op2]
#[serde]
pub fn op_vst3_note_on(#[serde] config: Vst3NoteConfig) -> Json {
    match vst3::with_instrument(&config.track_id, |i| i.note_on(config.channel, config.note, config.velocity, config.duration)) {
        Some(()) => json!({ "ok": true }),
        None => err("no VST3 instrument on this track"),
    }
}

#[op2(fast)]
pub fn op_vst3_all_notes_off(#[string] track_id: String) {
    vst3::with_instrument(&track_id, |i| i.all_notes_off());
}

#[op2]
#[serde]
pub fn op_vst3_open_editor(#[string] track_id: String) -> Json {
    match vst3::with_instrument(&track_id, |i| i.open_editor()) {
        Some(Ok(())) => json!({ "ok": true }),
        Some(Err(e)) => err(e),
        None => err("no VST3 instrument on this track"),
    }
}

#[op2(fast)]
pub fn op_vst3_close_editor(#[string] track_id: String) {
    vst3::with_instrument(&track_id, |i| i.close_editor());
}

/// The state snapshot `service()` took since the last poll (editor closed, or parameters edited and
/// left alone for a second), as base64, or null. Cheap enough to call every frame.
#[op2]
#[string]
pub fn op_vst3_poll_state(#[string] track_id: String) -> Option<String> {
    vst3::with_instrument(&track_id, |i| i.take_captured_state())
        .flatten()
        .map(|bytes| B64.encode(bytes))
}

/// An explicit state snapshot taken right now (locks the plugin, so it can cost the audio thread a
/// block or two of silence on a big plugin).
#[op2]
#[string]
pub fn op_vst3_save_state(#[string] track_id: String) -> Option<String> {
    vst3::with_instrument(&track_id, |i| i.save_state().ok())
        .flatten()
        .map(|bytes| B64.encode(bytes))
}

#[op2]
#[serde]
pub fn op_vst3_find_parameters(#[string] track_id: String, #[string] query: String, #[smi] limit: u32) -> Json {
    match vst3::with_instrument(&track_id, |i| i.find_parameters(&query, limit.max(1) as usize)) {
        Some(found) => json!({ "ok": true, "parameters": found }),
        None => err("no VST3 instrument on this track"),
    }
}

#[op2]
#[serde]
pub fn op_vst3_set_parameter(#[string] track_id: String, #[smi] id: u32, value: f64) -> Json {
    match vst3::with_instrument(&track_id, |i| i.set_parameter(id, value)) {
        Some(Ok(())) => json!({ "ok": true }),
        Some(Err(e)) => err(e),
        None => err("no VST3 instrument on this track"),
    }
}

/// Peak level (linear) rendered since the last call, for a level meter. Null with no instrument.
#[op2]
#[serde]
pub fn op_vst3_take_peak(#[string] track_id: String) -> Json {
    match vst3::with_instrument(&track_id, |i| i.take_peak()) {
        Some(peak) => json!(peak),
        None => Json::Null,
    }
}

#[op2]
#[serde]
pub fn op_vst3_stats() -> Json {
    json!(vst3::all_stats())
}
