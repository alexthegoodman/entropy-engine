//! Queue-only P2P bridge. Every runtime owns its service; no process-global singleton.
use crate::{
    deno::addon_ops::AddonContext,
    p2p::service::{Command, P2pService, ServiceConfig},
};
use deno_core::{OpState, op2};
use serde_json::{Value as Json, json};

#[op2]
#[serde]
pub fn op_p2p_start(state: &mut OpState, #[serde] config: ServiceConfig) -> Json {
    if let Some(service) = state.try_borrow::<P2pService>() {
        if !service.is_finished() {
            return json!({"error":"Current room is running or stopping; leave it and retry after shutdown"});
        }
        state.try_take::<P2pService>();
    }
    let Some(dir) = state
        .try_borrow::<AddonContext>()
        .and_then(|c| c.data_dir.clone())
    else {
        return json!({"error":"P2P requires an app data directory"});
    };
    match P2pService::start(dir.join("p2p-room"), config) {
        Ok(service) => {
            state.put(service);
            json!({"queued":true})
        }
        Err(e) => json!({"error":e.to_string()}),
    }
}
#[op2]
#[serde]
pub fn op_p2p_command(state: &mut OpState, #[serde] command: Command) -> Json {
    let Some(service) = state.try_borrow::<P2pService>() else {
        return json!({"error":"Join a room first"});
    };
    match service.command(command) {
        Ok(()) => json!({"queued":true}),
        Err(e) => json!({"error":e.to_string()}),
    }
}
#[op2]
#[serde]
pub fn op_p2p_poll(state: &mut OpState) -> Json {
    state
        .try_borrow_mut::<P2pService>()
        .and_then(|s| s.poll())
        .map(|v| json!(v))
        .unwrap_or(Json::Null)
}
#[op2]
#[serde]
pub fn op_p2p_stop(state: &mut OpState) -> Json {
    if let Some(service) = state.try_borrow::<P2pService>() {
        service.stop();
    }
    json!({"queued":true})
}
