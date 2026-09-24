//! Runs the real bundled ML graph addon and verifies actual Burn training outcomes and
//! architecture graph persistence. Actions come from features/ml_graph_live.feature.

use std::process::Command;

#[tokio::main]
async fn main() {
    let root = std::env::current_dir().unwrap().join("test-artifacts").join(format!("ml-graph-bdd-{}", std::process::id()));
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let result_path = root.join("result.json");
    let example = std::env::var_os("CARGO_BIN_EXE_example").expect("Cargo must provide the real example binary");
    let status = Command::new(example)
        .arg("ml-graph-demo")
        .env("ENTROPY_ML_BDD_RESULT", &result_path)
        .env("ENTROPY_ML_BDD_DATA", &data)
        .status()
        .expect("launch the real ML graph addon");
    assert!(status.success(), "the ML graph addon must exit cleanly: {status}");

    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(&result_path).expect("live BDD result")).expect("valid result JSON");
    assert_eq!(result["status"], "passed", "{result:#}");
    let artifacts = result["artifacts"].as_array().expect("artifact array");
    assert_eq!(artifacts.len(), 8, "{result:#}");
    for artifact in artifacts {
        assert!(std::path::Path::new(artifact.as_str().unwrap()).is_file(), "missing screenshot {artifact}");
    }

    let saved: serde_json::Value = serde_json::from_slice(
        &std::fs::read(data.join("ML Graph Trainer.json")).expect("addon-persisted graph and training report"),
    ).expect("valid addon JSON");
    let runs = saved["trainingRuns"].as_array().expect("training runs");
    assert_eq!(runs.len(), 3, "{saved:#}");
    for (index, (run, dataset)) in runs.iter().zip(["xor", "two_moons", "and"]).enumerate() {
        assert_eq!(run["dataset"], dataset, "{run:#}");
        assert_eq!(run["seed"], 42, "{run:#}");
        assert_eq!(run["epochs"], 250, "{run:#}");
        assert_eq!(run["hiddenUnits"], if index == 0 { serde_json::json!([8]) } else { serde_json::json!([8, 8]) }, "graph edit did not reach the trainer: {run:#}");
        let first = run["firstLoss"].as_f64().expect("first loss");
        let final_loss = run["finalLoss"].as_f64().expect("final loss");
        let accuracy = run["accuracy"].as_f64().expect("final accuracy");
        assert!(first.is_finite() && final_loss.is_finite() && final_loss < first * 0.8,
            "{dataset} loss did not improve enough: {first} -> {final_loss}");
        assert!(accuracy >= 0.75, "{dataset} accuracy too low: {accuracy}");
        println!("{dataset}: loss {first:.4} -> {final_loss:.4}, accuracy {:.1}%", accuracy * 100.0);
    }

    assert_eq!(saved["architectureKind"], "mini_pic", "{saved:#}");
    let graph = &saved["architecture"];
    assert!(graph["nodes"].as_array().unwrap().iter().any(|n| n["kind"] == "Concat2d"), "U-Net skip node was not saved");
    assert!(graph["links"].as_array().unwrap().iter().any(|l| l["from"] == "mid_attn" && l["to"] == "merge3" && l["input"] == "a"),
        "saved U-Net must retain the skip-merge input");
    println!("ML graph live BDD passed with {} screenshots in {}", artifacts.len(), root.display());
}
