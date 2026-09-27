// Cross-platform (non-Windows) video codec layer: the stand-in for Media Foundation on Linux (and
// any other non-Windows desktop target). Everything that used to be Windows-only because it
// wrapped Media Foundation - the media player example (`crate::media_player`), Stunts videos
// (`renderer_videos::st_video::StVideo`) and video export (`crate::video_export`) - goes through
// the three types here instead:
//
// - `Mp4VideoDecoder`: demuxes the H.264 track of an MP4 (`mp4` crate) and decodes it with Cisco's
//   OpenH264 (`openh264` crate, built from bundled source) into tightly-packed RGBA8 frames.
// - `Mp4AudioDecoder`: decodes the AAC track of the same file with symphonia (already in the tree
//   via rodio) into interleaved f32 chunks.
// - `Mp4VideoEncoder`: encodes tightly-packed RGBA8 frames with OpenH264 and muxes them into an
//   MP4 (`mp4` crate).
//
// Windows keeps its Media Foundation code paths untouched; nothing here is compiled there.
//
// OpenH264 only handles H.264, so unlike Media Foundation this path can't open HEVC/VP9/AV1 files -
// `Mp4VideoDecoder::open` reports that as an error rather than silently showing nothing.

mod audio;
mod decode;
mod encode;

pub use audio::Mp4AudioDecoder;
pub use decode::{Mp4VideoDecoder, VideoInfo};
pub use encode::Mp4VideoEncoder;
