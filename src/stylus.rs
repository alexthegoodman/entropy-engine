// Stylus tilt capture (Windows only).
//
// winit 0.30.12's `WindowEvent::Touch` carries pressure (`Force`, sourced from
// `GetPointerPenInfo`'s `pressure` field - see winit's
// `platform_impl/windows/event_loop.rs`, the `WM_POINTERDOWN | WM_POINTERUPDATE | WM_POINTERUP`
// arm) but nothing else from the pen packet: no `tiltX`/`tiltY`, no `rotation`. Those fields
// exist on the same `POINTER_PEN_INFO` struct Win32 hands back - winit's own Windows backend
// just never reads them into its cross-platform `Force` enum, which only has room for pressure
// and (on iOS only) a single altitude angle. There's no winit API to get them from outside the
// crate either.
//
// The fix: `EventLoopBuilderExtWindows::with_msg_hook` runs a callback on every Win32 message
// *before* winit's own `WindowProc` handles it, on the same thread, in the same call stack. For
// a `WM_POINTERUPDATE`/`WM_POINTERDOWN`/`WM_POINTERUP`, we call `GetPointerPenInfo` ourselves
// right there to pull `tiltX`/`tiltY`, stash it keyed by pointer ID, and return `false` (don't
// suppress winit's own dispatch - it still needs this same message to build its `Touch` event).
// By the time that `Touch` event reaches `startup.rs`'s event loop, the matching tilt reading is
// already sitting in this module's map, correlated by `Touch::id` (which winit sets from the
// same Win32 pointer ID).
//
// This doubles as the pen/mouse/touch discriminator `handlers::handle_stylus_touch` needs.
// `WM_POINTERDOWN` et al. fire for every pointer type - Windows 8+ routes ordinary mouse clicks
// through them too, alongside the legacy `WM_LBUTTONDOWN` family, unless a window opts out - and
// winit's own `Touch` event doesn't distinguish PT_MOUSE/PT_TOUCH/PT_PEN either (its `force`
// field is `None` for all three unless the backend specifically recognized PT_TOUCH or PT_PEN).
// `GetPointerPenInfo` itself only succeeds for a real PT_PEN pointer ID, so an entry present in
// this map *is* the "this was actually a pen" signal, not just a tilt cache.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use windows::Win32::UI::Input::Pointer::{GetPointerPenInfo, POINTER_PEN_INFO};
use windows::Win32::UI::WindowsAndMessaging::{MSG, WM_POINTERDOWN, WM_POINTERUP, WM_POINTERUPDATE};

/// Tilt reading for one pointer, in degrees (`POINTER_PEN_INFO::tiltX/tiltY`'s native unit):
/// 0 is the pen standing straight up off the surface, +-90 is flat against it. `None` for an
/// axis means this pen's driver didn't report it (`PEN_MASK_TILT_X`/`PEN_MASK_TILT_Y` unset in
/// `penMask`) - most cheap styli only ever report pressure.
#[derive(Clone, Copy, Debug, Default)]
pub struct PenTilt {
    pub tilt_x: Option<f32>,
    pub tilt_y: Option<f32>,
}

// PEN_MASK_TILT_X / PEN_MASK_TILT_Y aren't exposed as named constants by the `windows` crate's
// Pointer module (unlike the POINTER_MESSAGE_FLAG_* / POINTER_FLAG_* families it does bind) -
// these are the literal bit values from `winuser.h`.
const PEN_MASK_TILT_X: u32 = 0x00000004;
const PEN_MASK_TILT_Y: u32 = 0x00000008;

fn tilt_map() -> &'static Mutex<HashMap<u32, PenTilt>> {
    static MAP: OnceLock<Mutex<HashMap<u32, PenTilt>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Install as `EventLoopBuilder::with_msg_hook`. Returns `false` always - this only observes
/// pointer messages, it never claims to have handled them.
pub fn msg_hook_capture_tilt(msg_ptr: *const c_void) -> bool {
    // Safety: `with_msg_hook`'s contract is that `msg_ptr` points to a valid Win32 `MSG` for the
    // duration of this call - the same guarantee winit's own doc example relies on.
    let msg = unsafe { &*(msg_ptr as *const MSG) };

    if !matches!(msg.message, WM_POINTERDOWN | WM_POINTERUPDATE | WM_POINTERUP) {
        return false;
    }

    // Per the WM_POINTER* docs, the pointer ID is the LOWORD of wParam.
    let pointer_id = (msg.wParam.0 as u32) & 0xFFFF;

    let mut pen_info = POINTER_PEN_INFO::default();
    // GetPointerPenInfo errors (not a pen, or an unknown/stale pointer ID) just mean "no tilt
    // for this pointer" - fine to drop, winit's own Touch event still goes through normally.
    if unsafe { GetPointerPenInfo(pointer_id, &mut pen_info) }.is_ok() {
        let tilt_x = (pen_info.penMask & PEN_MASK_TILT_X != 0).then_some(pen_info.tiltX as f32);
        let tilt_y = (pen_info.penMask & PEN_MASK_TILT_Y != 0).then_some(pen_info.tiltY as f32);
        tilt_map()
            .lock()
            .unwrap()
            .insert(pointer_id, PenTilt { tilt_x, tilt_y });
    }

    false
}

/// Looks up the most recent tilt reading for a pointer ID (`winit::event::Touch::id`, truncated
/// to `u32` - Win32 pointer IDs are 16-bit, so this never loses information). `None` means this
/// pointer ID was never seen by a successful `GetPointerPenInfo` call - i.e. it isn't a pen.
pub fn tilt_for(pointer_id: u32) -> Option<PenTilt> {
    tilt_map().lock().unwrap().get(&pointer_id).copied()
}

/// Drops a pointer ID's stored reading. Call once its `Touch` has reached `TouchPhase::Ended`/
/// `Cancelled` (after reading `tilt_for` for that same event) so a future, unrelated pointer ID
/// reuse doesn't inherit a stale reading.
pub fn clear_tilt_for(pointer_id: u32) {
    tilt_map().lock().unwrap().remove(&pointer_id);
}
