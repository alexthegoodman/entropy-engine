//! Headless correctness check for `entropy_engine::ml_graph`: builds the same JSON graph shape
//! the addon UI would send, trains it on both synthetic datasets, and prints per-epoch loss plus
//! final accuracy. Run with `cargo run --bin ml_graph_bench`.

use entropy_engine::ml_graph::MlTrainer;
use std::time::Duration;

fn graph_json(hidden: &[usize], out_units: usize) -> String {
    let mut nodes = vec!["{\"kind\":\"Input\",\"id\":\"in\",\"size\":2}".to_string()];
    let mut links = Vec::new();
    let mut prev = "in".to_string();
    for (i, units) in hidden.iter().enumerate() {
        let id = format!("h{i}");
        nodes.push(format!("{{\"kind\":\"Dense\",\"id\":\"{id}\",\"units\":{units},\"activation\":\"relu\"}}"));
        links.push(format!("{{\"from\":\"{prev}\",\"to\":\"{id}\"}}"));
        prev = id;
    }
    nodes.push(format!("{{\"kind\":\"Dense\",\"id\":\"out\",\"units\":{out_units},\"activation\":\"linear\"}}"));
    links.push(format!("{{\"from\":\"{prev}\",\"to\":\"out\"}}"));
    links.push("{\"from\":\"out\",\"to\":\"loss\"}".to_string());
    nodes.push("{\"kind\":\"Loss\",\"id\":\"loss\"}".to_string());

    format!("{{\"nodes\":[{}],\"links\":[{}]}}", nodes.join(","), links.join(","))
}

fn run(name: &str, dataset: &str, hidden: &[usize], epochs: usize, lr: f64) {
    println!("=== {name} ({dataset}, hidden={hidden:?}, epochs={epochs}, lr={lr}) ===");
    let graph = graph_json(hidden, 2);
    let mut trainer = MlTrainer::start_seeded(&graph, dataset, epochs, lr, 42).expect("graph should be valid");

    let mut last_printed_epoch = 0;
    loop {
        let updates = trainer.poll();
        let mut done = false;
        for u in updates {
            if u.epoch == 1 || u.epoch % (epochs / 10).max(1) == 0 || u.done {
                println!("  epoch {:4}/{}  loss={:.6}{}", u.epoch, u.total_epochs, u.loss, u.accuracy.map(|a| format!("  accuracy={:.1}%", a * 100.0)).unwrap_or_default());
            }
            last_printed_epoch = u.epoch;
            if u.done {
                done = true;
            }
        }
        if done {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = last_printed_epoch;
    println!();
}

fn main() {
    run("XOR", "xor", &[8], 300, 0.05);
    run("Two Moons", "two_moons", &[16, 16], 200, 0.02);

    println!("=== Validation errors surface synchronously (no thread spun up) ===");
    match MlTrainer::start_seeded(&graph_json(&[8], 3), "xor", 10, 0.05, 42) {
        Ok(_) => println!("  UNEXPECTED: mismatched output size was accepted"),
        Err(e) => println!("  OK: {e}"),
    }
    match MlTrainer::start_seeded("{\"nodes\":[],\"links\":[]}", "xor", 10, 0.05, 42) {
        Ok(_) => println!("  UNEXPECTED: empty graph was accepted"),
        Err(e) => println!("  OK: {e}"),
    }
}
