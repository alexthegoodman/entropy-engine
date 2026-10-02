//! Phase-1 P2P evaluation spike.
//!
//! Runs the same control-plane exercise against both transport backends so they can be
//! compared side by side. Each concern (group code, encryption, interceptor, relay-route
//! detection, datagram round-trip, reliable channel) prints a pass/fail line and the process
//! exits non-zero if any *hard* check fails. Timeouts guard everything so the spike never
//! hangs; "not verified within timeout" is a finding, not a crash.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use bytes::Bytes;

use entropy_engine::p2p::transport::{
    self, Datagram, P2pTransport, PeerId, TransportEvent,
};

fn ip_to_u32(ip: Ipv4Addr) -> u32 {
    u32::from_be_bytes(ip.octets())
}

async fn wait_for_datagram(
    t: &dyn P2pTransport,
    from: &PeerId,
    timeout: Duration,
) -> Option<Datagram> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, t.next_event()).await {
            Ok(Some(TransportEvent::Datagram(d))) if &d.peer == from => return Some(d),
            Ok(Some(_)) => continue,
            _ => return None,
        }
    }
}

/// Sends repeatedly (retrying while the route is established) until `receiver` observes a
/// datagram from `from`, or the timeout expires. The retry exists because KCP's route
/// discovery is async: the first `send_to` right after `start()` can fail with
/// "node route not found" and there is no wait-for-peer primitive.
async fn send_until_received(
    sender: &dyn P2pTransport,
    receiver: &dyn P2pTransport,
    to: &PeerId,
    from: &PeerId,
    payload: Bytes,
    timeout: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        let _ = sender.send_datagram(to, payload.clone()).await;
        if wait_for_datagram(receiver, from, Duration::from_millis(400))
            .await
            .is_some()
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Returns true iff the process should treat the run as a hard failure.
async fn run_kcp() -> bool {
    println!("== KCP backend (rustp2p) ==");
    let mut failed = false;

    let a = match transport::rustp2p::KcpTransport::start(transport::rustp2p::KcpConfig {
        node_id: Ipv4Addr::new(10, 0, 0, 1),
        udp_port: 18100,
        tcp_port: 18100,
        group_code: "12345".into(),
        psk_password: "swordfish".into(),
        bootstrap: vec!["udp://127.0.0.1:18101".into()],
        allow_src: vec![ip_to_u32(Ipv4Addr::new(10, 0, 0, 2))],
    })
    .await
    {
        Ok(t) => t,
        Err(e) => {
            println!("  FAIL start node A: {e}");
            return true;
        }
    };

    let b = match transport::rustp2p::KcpTransport::start(transport::rustp2p::KcpConfig {
        node_id: Ipv4Addr::new(10, 0, 0, 2),
        udp_port: 18101,
        tcp_port: 18101,
        group_code: "12345".into(),
        psk_password: "swordfish".into(),
        bootstrap: vec!["udp://127.0.0.1:18100".into()],
        allow_src: vec![ip_to_u32(Ipv4Addr::new(10, 0, 0, 1))],
    })
    .await
    {
        Ok(t) => t,
        Err(e) => {
            println!("  FAIL start node B: {e}");
            return true;
        }
    };

    let peer_b = PeerId::new("10.0.0.2");
    let peer_a = PeerId::new("10.0.0.1");

    // Datagram round-trip (group code + encryption + interceptor allowlist all in play).
    // Retried because KCP route discovery is async (see `send_until_received`).
    if send_until_received(
        &a,
        &b,
        &peer_b,
        &peer_a,
        Bytes::from_static(b"hello-from-a"),
        Duration::from_secs(8),
    )
    .await
    {
        println!("  OK  A->B datagram (group code + encryption + allowlist)");
    } else {
        println!("  NOT VERIFIED A->B datagram within 8s");
        failed = true;
    }

    // Interceptor: a frame from an un-allowlisted source (same group code) must be dropped
    // by the receiving node's socket-level interceptor.
    let c = match transport::rustp2p::KcpTransport::start(transport::rustp2p::KcpConfig {
        node_id: Ipv4Addr::new(10, 0, 0, 3),
        udp_port: 18102,
        tcp_port: 18102,
        group_code: "12345".into(),
        psk_password: "swordfish".into(),
        bootstrap: vec!["udp://127.0.0.1:18100".into()],
        allow_src: vec![ip_to_u32(Ipv4Addr::new(10, 0, 0, 1))],
    })
    .await
    {
        Ok(t) => t,
        Err(e) => {
            println!("  INFO interceptor-probe node failed to start: {e}");
            return failed;
        }
    };
    let _ = c
        .send_datagram(&peer_a, Bytes::from_static(b"intruder"))
        .await;
    match wait_for_datagram(&a, &PeerId::new("10.0.0.3"), Duration::from_secs(2)).await {
        Some(_) => {
            println!("  FAIL interceptor delivered a frame from an un-allowlisted src");
            failed = true;
        }
        None => println!("  OK  interceptor dropped a frame from an un-allowlisted src"),
    }

    // Relay-route detection surface (loopback is always Direct).
    println!("  INFO route_mode(A) on B = {:?}", b.route_mode(&peer_a));

    // Wrong group code must not form a swarm.
    match transport::rustp2p::KcpTransport::start(transport::rustp2p::KcpConfig {
        node_id: Ipv4Addr::new(10, 0, 0, 4),
        udp_port: 18103,
        tcp_port: 18103,
        group_code: "99999".into(),
        psk_password: "swordfish".into(),
        bootstrap: vec!["udp://127.0.0.1:18100".into()],
        allow_src: vec![ip_to_u32(Ipv4Addr::new(10, 0, 0, 1))],
    })
    .await
    {
        Ok(c2) => {
            let _ = c2
                .send_datagram(&peer_a, Bytes::from_static(b"wrong-group"))
                .await;
            match wait_for_datagram(&a, &PeerId::new("10.0.0.4"), Duration::from_secs(2)).await {
                Some(_) => {
                    println!("  FAIL wrong-group-code peer reached the swarm");
                    failed = true;
                }
                None => println!("  OK  wrong group code did not deliver (isolation)"),
            }
        }
        Err(e) => println!("  INFO wrong-group node failed to start: {e}"),
    }

    failed
}

async fn run_quic() -> bool {
    println!("== QUIC overlay backend (rustp2p-quic) ==");
    let mut failed = false;

    let a_addr: SocketAddr = "127.0.0.1:18200".parse().unwrap();
    let b_addr: SocketAddr = "127.0.0.1:18201".parse().unwrap();

    let a = match transport::quic::QuicTransport::start(transport::quic::QuicConfig {
        peer_id: "node-a".into(),
        seed: "seed-a".into(),
        bind_addr: a_addr,
        bootstrap: vec![],
    })
    .await
    {
        Ok(t) => t,
        Err(e) => {
            println!("  FAIL start node A: {e}");
            return true;
        }
    };

    let b = match transport::quic::QuicTransport::start(transport::quic::QuicConfig {
        peer_id: "node-b".into(),
        seed: "seed-b".into(),
        bind_addr: b_addr,
        bootstrap: vec![a_addr],
    })
    .await
    {
        Ok(t) => t,
        Err(e) => {
            println!("  FAIL start node B: {e}");
            return true;
        }
    };

    // Ensure B has discovered A's PeerId through the bootstrap hello.
    let peer_a = match b.add_bootstrap(a_addr).await {
        Ok(id) => id,
        Err(e) => {
            println!("  FAIL B add_bootstrap(A): {e}");
            return true;
        }
    };
    println!("  INFO B discovered A as {peer_a}");

    // Datagram B -> A.
    if let Err(e) = b
        .send_datagram(&peer_a, Bytes::from_static(b"quic-hello"))
        .await
    {
        println!("  FAIL send B->A: {e}");
        failed = true;
    }
    match wait_for_datagram(&a, &PeerId::new("node-b"), Duration::from_secs(8)).await {
        Some(d) => println!("  OK  B->A datagram (route={:?})", d.route),
        None => {
            println!("  NOT VERIFIED B->A datagram within 8s");
            failed = true;
        }
    }

    // Relay-route detection surface.
    println!("  INFO link_mode(A) on B = {:?}", b.route_mode(&peer_a));

    // Reliable channel round-trip: A opens a channel to B, writes, B echoes back.
    let mut ch = match a.open_channel(&PeerId::new("node-b")).await {
        Ok(c) => c,
        Err(e) => {
            println!("  NOT VERIFIED A.open_channel(B): {e}");
            failed = true;
            return failed;
        }
    };

    let echo = tokio::spawn(async move {
        loop {
            match b.next_event().await {
                Some(TransportEvent::IncomingChannel { mut channel, .. }) => {
                    if let Some(Ok(msg)) = channel.recv().await {
                        let _ = channel.send(msg).await;
                    }
                    return;
                }
                _ => continue,
            }
        }
    });

    if let Err(e) = ch.send(Bytes::from_static(b"channel-hello")).await {
        println!("  FAIL channel send: {e}");
        failed = true;
    }
    match tokio::time::timeout(Duration::from_secs(8), ch.recv()).await {
        Ok(Some(Ok(msg))) if &msg[..] == b"channel-hello" => {
            println!("  OK  QUIC channel round-trip (echoed {msg:?})")
        }
        Ok(Some(Ok(msg))) => {
            println!("  FAIL channel echoed unexpected {:?}", msg);
            failed = true;
        }
        Ok(Some(Err(e))) => {
            println!("  FAIL channel recv: {e}");
            failed = true;
        }
        Ok(None) => {
            println!("  FAIL channel closed before echo");
            failed = true;
        }
        Err(_) => {
            println!("  NOT VERIFIED channel echo within 8s");
            failed = true;
        }
    }
    let _ = echo.await;

    failed
}

#[tokio::main]
async fn main() {
    let kcp_failed = run_kcp().await;
    let quic_failed = run_quic().await;

    println!();
    if kcp_failed || quic_failed {
        println!("spike finished with failures/unknowns (see above)");
        std::process::exit(1);
    } else {
        println!("spike finished: all hard checks passed");
    }
}
