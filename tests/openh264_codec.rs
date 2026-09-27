//! OpenH264 codec layer (non-Windows video playback/export backend): encoder -> MP4 -> decoder
//! round trips, seeking, and decoding whatever sample MP4s are present in `public/`.
#![cfg(not(any(target_os = "windows", target_arch = "wasm32")))]

use entropy_engine::openh264_codec::{Mp4AudioDecoder, Mp4VideoDecoder, Mp4VideoEncoder};

const COLORS: [[u8; 3]; 4] = [[220, 40, 40], [40, 200, 60], [40, 60, 220], [235, 235, 235]];

/// Solid color per second of video, so any decoded frame's timestamp says what it must look like.
fn frame(width: u32, height: u32, index: u32, fps: u32) -> Vec<u8> {
    let [r, g, b] = COLORS[(index / fps) as usize % COLORS.len()];
    (0..width * height).flat_map(|_| [r, g, b, 255]).collect()
}

fn center_pixel(rgba: &[u8], width: u32, height: u32) -> [u8; 3] {
    let i = ((height / 2 * width + width / 2) * 4) as usize;
    [rgba[i], rgba[i + 1], rgba[i + 2]]
}

fn assert_close(actual: [u8; 3], expected: [u8; 3], context: &str) {
    let off = actual.iter().zip(expected).map(|(&a, e)| (a as i32 - e as i32).abs()).max().unwrap();
    assert!(off <= 16, "{context}: decoded {actual:?}, expected about {expected:?}");
}

fn encode(path: &std::path::Path, width: u32, height: u32, fps: u32, frames: u32) {
    let mut encoder = Mp4VideoEncoder::new(path.to_str().unwrap(), width, height, fps).expect("encoder");
    for index in 0..frames {
        encoder.write_frame(&frame(width, height, index, fps)).expect("encode frame");
    }
    encoder.finish().expect("finalize mp4");
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("entropy-openh264-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

#[test]
fn encoded_mp4_decodes_back_with_matching_frames_and_timing() {
    let path = scratch("roundtrip.mp4");
    let (fps, frames) = (30, 120);
    encode(&path, 320, 240, fps, frames);

    let mut decoder = Mp4VideoDecoder::open(&path).expect("open exported mp4");
    let info = decoder.info();
    assert_eq!((info.width, info.height), (320, 240));
    assert!((info.frame_rate - 30.0).abs() < 0.01, "{info:?}");
    assert_eq!(info.duration_ms, 4000, "{info:?}");

    let mut rgba = Vec::new();
    let mut decoded = 0;
    let mut last_pts = -1.0;
    while let Some(pts) = decoder.next_frame(&mut rgba).expect("decode") {
        assert!(pts > last_pts, "timestamps must increase: {pts} after {last_pts}");
        last_pts = pts;
        assert_eq!(rgba.len(), 320 * 240 * 4);
        let index = (pts * fps as f64 / 1000.0).round() as u32;
        assert_eq!(index, decoded, "frame {decoded} came out at {pts} ms");
        assert_close(center_pixel(&rgba, 320, 240), COLORS[(index / fps) as usize % 4], &format!("frame {index}"));
        decoded += 1;
    }
    assert_eq!(decoded, frames);
}

#[test]
fn seeking_lands_on_the_requested_frame() {
    let path = scratch("seek.mp4");
    encode(&path, 256, 144, 30, 150);
    let mut decoder = Mp4VideoDecoder::open(&path).unwrap();
    let mut rgba = Vec::new();

    for target_ms in [2500i64, 500, 4100, 0, 3000] {
        decoder.seek(target_ms).unwrap();
        let pts = decoder.next_frame(&mut rgba).unwrap().expect("a frame after seeking");
        assert!((pts - target_ms as f64).abs() < 34.0, "seek to {target_ms} landed on {pts}");
        assert_close(center_pixel(&rgba, 256, 144), COLORS[(target_ms / 1000) as usize % 4], &format!("seek {target_ms}"));
    }
    decoder.seek(4990).unwrap();
    assert!(decoder.next_frame(&mut rgba).unwrap().is_some(), "last frame is still reachable");
    assert!(decoder.next_frame(&mut rgba).unwrap().is_none(), "then end of stream");
}

#[test]
fn odd_frame_sizes_are_cropped_to_even() {
    let path = scratch("odd.mp4");
    let (width, height) = (101, 75);
    let mut encoder = Mp4VideoEncoder::new(path.to_str().unwrap(), width, height, 24).unwrap();
    for index in 0..10 {
        encoder.write_frame(&frame(width, height, index, 24)).unwrap();
    }
    drop(encoder); // finalizes like the Media Foundation encoder does on drop

    let mut decoder = Mp4VideoDecoder::open(&path).unwrap();
    assert_eq!((decoder.info().width, decoder.info().height), (100, 74));
    let mut rgba = Vec::new();
    assert!(decoder.next_frame(&mut rgba).unwrap().is_some());
    assert_close(center_pixel(&rgba, 100, 74), COLORS[0], "odd-size frame");
}

#[test]
fn bad_inputs_report_errors_instead_of_panicking() {
    assert!(Mp4VideoDecoder::open("definitely/not/here.mp4").is_err());
    let not_mp4 = scratch("not.mp4");
    std::fs::write(&not_mp4, b"this is not an mp4 file").unwrap();
    assert!(Mp4VideoDecoder::open(&not_mp4).is_err());
    assert!(Mp4AudioDecoder::open(&not_mp4).is_err());
    assert!(Mp4VideoEncoder::new("/nonexistent-dir/out.mp4", 64, 64, 30).is_err());
    // An exported video has no audio track.
    let silent = scratch("silent.mp4");
    encode(&silent, 64, 64, 30, 5);
    assert!(Mp4AudioDecoder::open(&silent).is_err());
}

/// The media player's playlist files are gitignored, so this only checks whichever are present
/// locally: every sample decodes, in order, with audio where the file has it.
#[test]
fn local_sample_videos_decode_start_to_finish() {
    let samples: Vec<_> = std::fs::read_dir("public")
        .map(|dir| dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "mp4")).collect())
        .unwrap_or_default();
    for path in samples {
        let mut decoder = match Mp4VideoDecoder::open(&path) {
            Ok(decoder) => decoder,
            Err(error) => {
                println!("skipping {}: {error}", path.display());
                continue;
            }
        };
        let info = decoder.info();
        let mut rgba = Vec::new();
        let mut frames = 0u32;
        let mut last = -1.0;
        while let Some(pts) = decoder.next_frame(&mut rgba).unwrap() {
            assert!(pts > last, "{}: frame {frames} at {pts} after {last}", path.display());
            last = pts;
            frames += 1;
        }
        let expected = info.duration_ms as f64 * info.frame_rate / 1000.0;
        assert!((frames as f64 - expected).abs() <= 2.0, "{}: {frames} frames, expected ~{expected} ({info:?})", path.display());

        let audio = match Mp4AudioDecoder::open(&path) {
            Ok(mut audio) => {
                let mut samples = 0usize;
                while let Some(chunk) = audio.next_chunk().unwrap() {
                    samples += chunk.len();
                }
                let seconds = samples as f64 / audio.channels() as f64 / audio.sample_rate() as f64;
                assert!((seconds * 1000.0 - info.duration_ms as f64).abs() < 250.0, "{}: {seconds}s of audio", path.display());
                format!("{} ch @ {} Hz, {seconds:.2}s", audio.channels(), audio.sample_rate())
            }
            Err(_) => "no audio".to_string(),
        };
        println!("{}: {}x{} @ {:.2} fps, {frames} frames, {audio}", path.display(), info.width, info.height, info.frame_rate);
    }
}

#[test]
fn catching_up_skips_to_the_current_frame() {
    let path = scratch("catchup.mp4");
    encode(&path, 128, 96, 30, 120);
    let mut decoder = Mp4VideoDecoder::open(&path).unwrap();
    let mut rgba = Vec::new();
    assert_eq!(decoder.next_frame(&mut rgba).unwrap(), Some(0.0));
    // 2.5 s behind: lands on the frame showing at 2.5 s, not the next one in line.
    let pts = decoder.next_frame_catching_up(2500.0 - 33.0, 1000, &mut rgba).unwrap().unwrap();
    assert!((pts - 2500.0).abs() < 34.0, "caught up to {pts}");
    assert_close(center_pixel(&rgba, 128, 96), COLORS[2], "caught-up frame");
    // A small budget bounds how far one call jumps.
    let pts = decoder.next_frame_catching_up(3900.0, 5, &mut rgba).unwrap().unwrap();
    assert!((pts - (pts_after(2500.0) + 6.0 * 1000.0 / 30.0)).abs() < 34.0, "budgeted catch-up landed on {pts}");
    // And plain reads continue in order afterwards.
    let next = decoder.next_frame(&mut rgba).unwrap().unwrap();
    assert!((next - pts - 1000.0 / 30.0).abs() < 1.0);
}

fn pts_after(ms: f64) -> f64 {
    (ms * 30.0 / 1000.0).round() * 1000.0 / 30.0
}

/// The media player shows the frame after a seek through `next_frame_catching_up`; its skip
/// budget must not cut a seek short when the target is far past the previous keyframe.
#[test]
fn seek_followed_by_catch_up_still_reaches_the_target() {
    let path = scratch("seek-catchup.mp4");
    encode(&path, 128, 96, 30, 120); // keyframes every 2 s
    let mut decoder = Mp4VideoDecoder::open(&path).unwrap();
    let mut rgba = Vec::new();
    decoder.seek(1900).unwrap();
    let pts = decoder.next_frame_catching_up(1900.0 - 33.0, 30, &mut rgba).unwrap().unwrap();
    assert!((pts - 1900.0).abs() < 34.0, "seek + catch-up landed on {pts}");
    assert_close(center_pixel(&rgba, 128, 96), COLORS[1], "seeked frame");
}
