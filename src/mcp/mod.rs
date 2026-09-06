//! Automatic MCP (Model Context Protocol) server.
//!
//! Every addon that calls `Entropy.Addon.register().registerTool(definition, callback)`
//! (see src/deno/addon_setup.js) already lands its tool in `AddonContext::registered_tools`
//! (src/deno/addon_ops.rs), which the WryChat webview polls over its own IPC channel.
//! This module exposes that exact same registry to *external* MCP clients - most notably
//! Claude Code - over the standard MCP Streamable HTTP transport, so pointing Claude Code
//! at this app is a `claude mcp add --transport http` away. Nothing about `registerTool`
//! itself changes: addons get MCP exposure for free, automatically, the moment this server
//! is running.
//!
//! The server runs on a background OS thread (tiny_http is blocking, not async) because the
//! V8 isolate backing `AddonEngine` is not `Send`/`Sync` and must only ever be touched from
//! the main/render thread. Requests that need the live tool registry are handed across a
//! channel (`McpRequest`) and answered by whichever loop polls `Editor::mcp_rx` each frame
//! (see `about_to_wait` in src/startup.rs), mirroring the existing `webview_ipc_rx` pattern.

use std::io::Read;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::deno::addon_ops::ToolDefinition;

const PROTOCOL_VERSION: &str = "2024-11-05";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A tool-registry request bridged from the MCP HTTP thread to the main engine thread.
/// The main thread answers these against the live `AddonEngine` and sends the result back
/// down `reply`.
pub enum McpRequest {
    ListTools {
        reply: Sender<Vec<ToolDefinition>>,
    },
    CallTool {
        name: String,
        arguments: String,
        reply: Sender<Option<String>>,
    },
}

fn port() -> u16 {
    std::env::var("ENTROPY_MCP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(47100)
}

/// Starts the MCP server in a background thread and returns the receiving end of the
/// channel the main thread should drain every frame. Safe to call once per `Editor`; if the
/// port is already bound (e.g. a second Editor in the same process) the thread logs and exits
/// quietly rather than taking down the app.
pub fn spawn() -> Receiver<McpRequest> {
    let (tx, rx) = channel::<McpRequest>();
    let port = port();

    thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(server) => server,
            Err(e) => {
                eprintln!("[MCP] Failed to bind MCP server on 127.0.0.1:{}: {}", port, e);
                return;
            }
        };

        println!(
            "[MCP] Entropy MCP server ready at http://127.0.0.1:{}/mcp - point Claude Code at it with:\n  claude mcp add --transport http entropy-engine http://127.0.0.1:{}/mcp",
            port, port
        );

        for mut request in server.incoming_requests() {
            if request.method() != &tiny_http::Method::Post {
                let _ = request.respond(tiny_http::Response::empty(405));
                continue;
            }

            let mut body = String::new();
            if let Err(e) = request.as_reader().read_to_string(&mut body) {
                eprintln!("[MCP] Failed to read request body: {}", e);
                let _ = request.respond(tiny_http::Response::empty(400));
                continue;
            }

            match handle_message(&tx, &body) {
                Some(response_body) => {
                    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .expect("static header is valid");
                    let _ = request.respond(tiny_http::Response::from_string(response_body).with_header(header));
                }
                None => {
                    // JSON-RPC notification: no response body is expected.
                    let _ = request.respond(tiny_http::Response::empty(202));
                }
            }
        }
    });

    rx
}

/// Parses one JSON-RPC message and returns the JSON string to send back, or `None` for
/// notifications (which per the JSON-RPC/MCP spec never get a response body).
fn handle_message(tx: &Sender<McpRequest>, body: &str) -> Option<String> {
    let request: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return Some(error_response(Value::Null, -32700, &format!("Parse error: {}", e))),
    };

    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");

    // Notifications carry no "id" and must never receive a response.
    if id.is_none() {
        return None;
    }
    let id = id.unwrap();

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": { "name": "entropy-engine", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => list_tools(tx),
        "tools/call" => call_tool(tx, request.get("params")),
        other => Err((-32601, format!("Method not found: {}", other))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }).to_string(),
        Err((code, message)) => error_response(id, code, &message),
    })
}

fn list_tools(tx: &Sender<McpRequest>) -> Result<Value, (i64, String)> {
    let (reply_tx, reply_rx) = channel();
    tx.send(McpRequest::ListTools { reply: reply_tx })
        .map_err(|_| (-32000, "Addon engine is not available".to_string()))?;

    let tools = reply_rx
        .recv_timeout(REQUEST_TIMEOUT)
        .map_err(|_| (-32000, "Timed out waiting for the addon engine".to_string()))?;

    let tools_json: Vec<Value> = tools
        .into_iter()
        .map(|def| {
            json!({
                "name": def.name,
                "description": def.description,
                "inputSchema": def.parameters,
            })
        })
        .collect();

    Ok(json!({ "tools": tools_json }))
}

fn call_tool(tx: &Sender<McpRequest>, params: Option<&Value>) -> Result<Value, (i64, String)> {
    let params = params.ok_or((-32602, "Missing params".to_string()))?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "Missing tool name".to_string()))?
        .to_string();
    let arguments = params.get("arguments").cloned().unwrap_or(json!({})).to_string();

    let (reply_tx, reply_rx) = channel();
    tx.send(McpRequest::CallTool {
        name: name.clone(),
        arguments,
        reply: reply_tx,
    })
    .map_err(|_| (-32000, "Addon engine is not available".to_string()))?;

    let result = reply_rx
        .recv_timeout(REQUEST_TIMEOUT)
        .map_err(|_| (-32000, "Timed out waiting for the addon engine".to_string()))?;

    Ok(match result {
        Some(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
        None => json!({
            "content": [{ "type": "text", "text": format!("Tool '{}' is not registered", name) }],
            "isError": true
        }),
    })
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}
