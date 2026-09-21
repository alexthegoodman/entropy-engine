//! The real capture device: opens the default input through cpal (WASAPI on Windows) and runs the
//! guitar engine on whatever it hears for a couple of seconds. No guitar is needed and none is
//! assumed: this checks the plumbing the synthetic tiers cannot, namely what the driver actually
//! grants (rate, buffer, format), that the callback keeps up, and that stopping is clean.
//!
//! It prints what it found. With no input device at all it reports that and passes, since a machine
//! with no microphone is not a failure of the code.
//!
//! `cargo test --release --test guitar_device_live -- --nocapture`

use entropy_engine::guitar::GuitarConfig;
use entropy_engine::guitar_live::{list_input_devices, GuitarSession, InputRequest};
use std::time::Duration;

#[test]
fn the_default_input_opens_runs_and_stops_cleanly() {
    let devices = list_input_devices();
    println!("input devices ({}):", devices.len());
    for d in &devices {
        println!("  [{}] {}  {} ch, default {} Hz{}", d.host, d.name, d.channels, d.default_sample_rate, if d.is_default { "  (default)" } else { "" });
    }
    if devices.is_empty() {
        println!("no input device on this machine, so there is nothing to open");
        return;
    }

    for requested in [128u32, 256, 512] {
        let req = InputRequest { buffer_frames: requested, ..InputRequest::default() };
        let (mut session, opened) = match GuitarSession::start(GuitarConfig::default(), req) {
            Ok(pair) => pair,
            Err(e) => {
                println!("asked for {requested} frames: could not open the default input: {e}");
                continue;
            }
        };
        println!("asked for {requested} frames: {} / {} at {} Hz, {} ch, {}, buffer {:?}", opened.host, opened.device, opened.sample_rate, opened.channels, opened.sample_format, opened.buffer_frames);
        for n in &opened.notes {
            println!("    note: {n}");
        }
        std::thread::sleep(Duration::from_millis(2000));
        let d = session.diagnostics();
        println!(
            "    {} callbacks of {} frames ({:.2} ms each), mean {:.1} us, max {} us, overruns {}, stream errors {}, level {:.1} dBFS",
            d.callbacks, d.buffer_frames, d.buffer_ms, d.mean_callback_us, d.max_callback_us, d.overruns, d.stream_errors, d.level_db
        );
        assert!(d.running, "the session reports itself running");
        assert!(d.callbacks > 20, "only {} callbacks in two seconds: the device is not delivering", d.callbacks);
        assert_eq!(d.overruns, 0, "the callback took longer than the audio it covered");
        session.stop();
        assert!(!session.diagnostics().running);
    }
}

#[test]
fn asking_for_a_device_that_is_not_there_says_so_and_asks_nothing_of_the_driver() {
    let req = InputRequest { device: Some("No Such Interface 9000".into()), ..InputRequest::default() };
    match GuitarSession::start(GuitarConfig::default(), req) {
        Ok(_) => panic!("opened a device that does not exist"),
        Err(e) => {
            println!("error text: {e}");
            assert!(e.contains("No Such Interface 9000") && e.contains("connected"), "the message does not say what happened: {e}");
        }
    }
}

#[test]
fn asking_for_more_channels_than_the_device_has_says_how_many_it_has() {
    let devices = list_input_devices();
    let Some(d) = devices.first() else { return };
    let req = InputRequest { device: Some(d.name.clone()), host: Some(d.host.clone()), channel: 63, ..InputRequest::default() };
    match GuitarSession::start(GuitarConfig::default(), req) {
        Ok(_) => panic!("opened channel 64 of a {} channel device", d.channels),
        Err(e) => {
            println!("error text: {e}");
            assert!(e.contains("channel") && e.contains(&d.channels.to_string()), "{e}");
        }
    }
}
