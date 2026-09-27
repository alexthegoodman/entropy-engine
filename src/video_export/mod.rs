#[cfg(target_os = "windows")]
pub mod encode;
// Everywhere else the encoder is OpenH264 + an MP4 muxer, with the same `VideoEncoder` API.
#[cfg(not(any(target_os = "windows", target_arch = "wasm32")))]
pub mod encode {
    pub use crate::openh264_codec::Mp4VideoEncoder as VideoEncoder;
}
#[cfg(not(target_arch = "wasm32"))]
pub mod exporter;
pub mod frame_buffer;
