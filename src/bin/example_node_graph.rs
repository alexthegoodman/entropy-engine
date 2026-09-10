#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/node_graph.js")
        .with_hot_reload(true)
        .with_title("Nocode Calculator")
        .with_window_size(1100.0, 700.0)
        .run()
        .expect("Couldn't run app");
}
