//! Adapter ownership checks with real sockets, including shutdown with a full event queue.
use entropy_engine::p2p::transport::{
    P2pTransport, PeerId,
    quic::{QuicConfig, QuicTransport},
    rustp2p::{KcpConfig, KcpTransport},
};
use std::{net::UdpSocket, time::Duration};
fn port() -> u16 {
    UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
async fn released(port: u16) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if UdpSocket::bind(("0.0.0.0", port)).is_ok() {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "UDP socket {port} survived shutdown"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
#[tokio::test]
async fn kcp_drop_releases_sockets_with_receive_backpressure() {
    let a_port = port();
    let b_port = port();
    let a = KcpTransport::start(KcpConfig {
        node_id: "10.44.0.1".parse().unwrap(),
        udp_port: a_port,
        tcp_port: 0,
        group_code: "lifecycle".into(),
        psk_password: String::new(),
        bootstrap: vec![format!("udp://127.0.0.1:{b_port}")],
        allow_src: vec![u32::from(
            "10.44.0.2".parse::<std::net::Ipv4Addr>().unwrap(),
        )],
    })
    .await
    .unwrap();
    let b = KcpTransport::start(KcpConfig {
        node_id: "10.44.0.2".parse().unwrap(),
        udp_port: b_port,
        tcp_port: 0,
        group_code: "lifecycle".into(),
        psk_password: String::new(),
        bootstrap: vec![format!("udp://127.0.0.1:{a_port}")],
        allow_src: vec![u32::from(
            "10.44.0.1".parse::<std::net::Ipv4Addr>().unwrap(),
        )],
    })
    .await
    .unwrap();
    let peer = PeerId::new("10.44.0.2");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while a
        .send_datagram(&peer, bytes::Bytes::from_static(b"probe"))
        .await
        .is_err()
    {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // B's adapter queue fills and the upstream bounded queue applies backpressure.
    for _ in 0..512 {
        a.send_datagram(
            &peer,
            bytes::Bytes::from_static(b"bounded rejected traffic"),
        )
        .await
        .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    drop(b);
    released(b_port).await;
    drop(a);
    released(a_port).await;
}
#[tokio::test]
async fn quic_explicit_shutdown_closes_adapter_and_upstream() {
    let p = port();
    let mut transport = QuicTransport::start(QuicConfig {
        peer_id: "lifecycle-quic".into(),
        seed: "lifecycle-test".into(),
        bind_addr: format!("127.0.0.1:{p}").parse().unwrap(),
        bootstrap: vec![],
    })
    .await
    .unwrap();
    transport.shutdown().await;
    assert!(
        tokio::time::timeout(Duration::from_secs(1), transport.next_event())
            .await
            .unwrap()
            .is_none()
    );
    drop(transport);
    released(p).await;
}
