# Entropy patch to rust-p2p-core 0.4.1

Adds a 25ms asynchronous sleep backoff in `src/tunnel/udp.rs` (`recv_from`) whenever an
error is ignored (`should_ignore_error(&e)`, notably Windows Winsock `WSAECONNRESET` 10054).

## Rationale
On Windows, when UDP packets are transmitted to a closed socket or non-running peer port on
loopback (127.0.0.1), the Windows network stack delivers ICMP Port Unreachable, which Winsock
reports as `WSAECONNRESET`. In Tokio on Windows, error responses do not clear socket readiness
tokens because only `WouldBlock` resets readiness. A tight `continue;` loop without yielding
spins at 100% CPU at Windows kernel DPC/DISPATCH_LEVEL, starving the OS scheduler and triggering
GPU TDR (black screen) and watchdog panics.

Sleeping 25ms yields execution cleanly to Tokio and prevents thread/DPC starvation.
