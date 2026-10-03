// Shared frame-side cache for future P2P apps. Polling coalesces worker snapshots.
export class P2pClient {
    state: any = { running: false, posts: [] };
    error = "";
    start(config: any) { return this.accept(Entropy.P2P.start(config)); }
    command(command: any) { return this.accept(Entropy.P2P.command(command)); }
    stop() { Entropy.P2P.stop(); this.state = { running: false, posts: [] }; }
    poll() { const state = Entropy.P2P.poll(); if (state) { this.state = state; this.error = state.error || ""; } }
    private accept(result: any) { this.error = result?.error || ""; return !this.error; }
}
