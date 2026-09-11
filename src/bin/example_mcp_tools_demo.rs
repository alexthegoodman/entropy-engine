#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/mcp_demo.js")
        .with_title("MCP Tools Demo")
        .with_window_size(1000.0, 700.0)
        .run()
        .expect("Couldn't run app");
}
