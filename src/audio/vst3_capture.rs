//! Screenshots of a plugin's native editor window, for the live BDD tier.
//!
//! The engine's own `request_ui_screenshot` reads back the composited wgpu frame, which never
//! contains a plugin editor: that is a separate top-level Win32 window drawn by the plugin. So this
//! asks Windows for the window's pixels instead. Two methods, tried in order:
//!
//! 1. `PrintWindow(PW_RENDERFULLCONTENT)` - the window renders itself into our bitmap, so it works
//!    even if something else is on top of it. Plugins that draw with a GPU surface can come back
//!    black or blank though.
//! 2. A screen copy (`BitBlt` from the desktop DC) after bringing the window to the front - sees
//!    whatever is really on screen, but only if the window is visible.
//!
//! Method 1's result is judged by how many distinct colours it contains; a near-uniform image falls
//! through to method 2. Which method produced the file is returned so a test can record it.

use std::path::Path;

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, FindWindowW, GetWindowRect, SetForegroundWindow, ShowWindow, SW_SHOW,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCapture {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub method: &'static str,
    /// How many distinct colours the saved image has (capped at 4096). A blank capture has 1-2.
    pub distinct_colors: usize,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `PW_RENDERFULLCONTENT`: also captures content composed by DWM (layered and GPU-drawn children).
const PW_RENDERFULLCONTENT: u32 = 2;

fn distinct_colors(rgba: &[u8]) -> usize {
    let mut seen = std::collections::HashSet::new();
    for px in rgba.chunks_exact(4) {
        seen.insert([px[0], px[1], px[2]]);
        if seen.len() >= 4096 {
            break;
        }
    }
    seen.len()
}

unsafe fn grab(hwnd: HWND, rect: &RECT, screen_copy: bool) -> Option<Vec<u8>> {
    let (width, height) = ((rect.right - rect.left).max(1), (rect.bottom - rect.top).max(1));
    let screen_dc = GetDC(None);
    let mem_dc = CreateCompatibleDC(screen_dc);
    let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
    let previous = SelectObject(mem_dc, bitmap);

    let drawn = if screen_copy {
        BitBlt(mem_dc, 0, 0, width, height, screen_dc, rect.left, rect.top, SRCCOPY).is_ok()
    } else {
        PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
    };

    let mut pixels = None;
    if drawn {
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        let lines = GetDIBits(mem_dc, bitmap, 0, height as u32, Some(bgra.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        if lines > 0 {
            for px in bgra.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }
            pixels = Some(bgra);
        }
    }

    SelectObject(mem_dc, previous);
    let _ = DeleteObject(bitmap);
    let _ = DeleteDC(mem_dc);
    ReleaseDC(None, screen_dc);
    pixels
}

/// Captures the top-level window titled `title` (the plugin editor window `vst3-host` creates uses
/// the class `VST3PluginWindow`) to a PNG.
pub fn capture_editor_window(title: &str, path: &Path) -> Result<WindowCapture, String> {
    unsafe {
        let class = wide("VST3PluginWindow");
        let title_w = wide(title);
        let hwnd = FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(title_w.as_ptr()))
            .map_err(|e| format!("no editor window titled {title:?}: {e}"))?;
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|e| format!("GetWindowRect: {e}"))?;
        let (width, height) = ((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32);
        if width == 0 || height == 0 {
            return Err(format!("editor window is {width}x{height}"));
        }

        let mut method = "PrintWindow";
        let mut rgba = grab(hwnd, &rect, false);
        if rgba.as_ref().map(|p| distinct_colors(p) < 8).unwrap_or(true) {
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            std::thread::sleep(std::time::Duration::from_millis(250));
            method = "screen copy";
            rgba = grab(hwnd, &rect, true);
        }
        let rgba = rgba.ok_or_else(|| "could not read the window's pixels".to_string())?;
        let colors = distinct_colors(&rgba);

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        image::save_buffer(path, &rgba, width, height, image::ColorType::Rgba8).map_err(|e| e.to_string())?;
        Ok(WindowCapture { path: path.to_string_lossy().into_owned(), width, height, method, distinct_colors: colors })
    }
}
