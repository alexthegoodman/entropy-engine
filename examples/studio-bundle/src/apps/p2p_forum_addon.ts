// import { P2pClient } from "./p2p_client";

const addon = Entropy.Addon.register({ 
    name: "p2p-forum", 
    version: "1.0.0", 
    description: "Peer-to-peer rooms and signed text posts", 
    author: ["Entropy Team"], 
    capabilities: { ui: true, needsViewport: false } 
});

// const client = new P2pClient();

let room = "", maintainer = "", groupCode = "", tracker = "http://127.0.0.1:47110";
let nodeId = "10.9.0.1", port = "47201", peers = "", advertiseAddress = "";
let title = "", body = "", selected = "", replyTo: string | null = null;
let joining = false, started = false;
let publishing: { previous: string | null; title: string; body: string } | null = null;
let lastPolledAt = -1;

let state: any = { running: false, posts: [] };

function poll() { const data = Entropy.P2P.poll(); if (data) { state = data; } }

const POLL_INTERVAL = 5; // 5 secs

function update(time: number) {
    if (lastPolledAt >= 0 && time >= lastPolledAt && (time - lastPolledAt) < POLL_INTERVAL) {
        return;
    }
    
    lastPolledAt = time;

    Entropy.println("P2P Polling...");
    poll();
}

function join(config?: any) {
    if (!config) {
        let parsed: any[];
        try { parsed = peers.trim() ? JSON.parse(peers) : []; } catch { 
            // Entropy.P2P.error = "Peers must be a JSON array of {id,address}"; 
            return; 
        }
        config = { room, maintainer, nodeId, port: Number(port), groupCode, tracker: tracker.trim() || null, peers: parsed, advertiseAddress: advertiseAddress.trim() || null };
    }
    
    joining = Entropy.P2P.start(config).queued as any;
    started = joining; 
    
    if (joining) {
        addon.IO.save(config);
        poll(); 
    }
}

function publish(args?: any) {
    if (publishing) return;
    
    const submittedTitle = args?.title ?? title, submittedBody = args?.body ?? body;
    const success = Entropy.P2P.command({ action: "publish", title: submittedTitle, body: submittedBody, parent: args?.parent ?? replyTo });
    
    if (success) {
        publishing = { previous: state.lastPublication ?? null, title: submittedTitle, body: submittedBody };
        poll();
    }
}

function render(win: string) {
    // Entropy.UI.Widget.label(win, { text: "GUI test", bold: true });
    if (state.running) joining = false;
    
    if (publishing && state.lastPublication && state.lastPublication !== publishing.previous) {
        if (title === publishing.title && body === publishing.body) { title = ""; body = ""; replyTo = null; }
        publishing = null;
    } else if (publishing && state.commandError) publishing = null;
    
    const w = Entropy.UI.Widget;
    w.label(win, { text: "P2P Forum", bold: true });
    
    if (state.error) w.label(win, { text: state.error });
    
    if (!started) {
        w.label(win, { text: "Join with trusted room and maintainer pins. Each window needs its own profile and UDP port." });
        const input = (id: string, label: string, value: string, change: (s: string) => void) => w.textInput(win, { id, label, value, onChange: change });
        input("forum_room", "Room (64 hex digits)", room, v => room = v);
        input("forum_maintainer", "Maintainer public key", maintainer, v => maintainer = v);
        input("forum_group", "Group code", groupCode, v => groupCode = v);
        input("forum_tracker", "Tracker URL (optional)", tracker, v => tracker = v);
        input("forum_node", "Local node ID", nodeId, v => nodeId = v);
        input("forum_port", "UDP port", port, v => port = v);
        input("forum_peers", "Peers JSON [{id,address}]", peers, v => peers = v);
        input("forum_advertise", "Advertised socket (optional)", advertiseAddress, v => advertiseAddress = v);
        w.button(win, { text: "Join room", onClick: () => join() });
        return;
    }
    
    w.label(win, { text: joining ? "Joining..." : state.running ? `Connected as ${state.author?.slice(0, 12)}${state.isMaintainer ? " (maintainer)" : ""}` : "Service stopped" });
    w.label(win, { text: state.trackerOnline ? "Tracker online" : "Tracker offline - local publishing and configured peers remain available" });
    w.button(win, { text: "Sync room", onClick: () => { Entropy.P2P.command({ action: "sync" }); poll(); } });
    w.button(win, { text: "Leave room", onClick: () => { Entropy.P2P.stop(); joining = started = false; publishing = null; selected = ""; } });
    w.separator(win);
    w.label(win, { text: replyTo ? "Compose reply" : "Compose a post", bold: true });
    w.textInput(win, { id: "forum_title", label: "Title", value: title, onChange: v => title = v });
    w.textInput(win, { 
        id: "forum_body", 
        label: "Body (up to 16 KiB)", 
        value: body, 
        // multiline: true, // TODO: causes freezing 
        onChange: v => body = v 
    }); 
    w.button(win, { id: "forum_publish", text: publishing ? "Publishing..." : "Publish", onClick: () => publish() });
    
    if (replyTo) w.button(win, { text: "Cancel reply", onClick: () => replyTo = null });
    
    w.separator(win);
    w.label(win, { text: `${state.posts.length} posts`, bold: true });
    
    for (const post of state.posts) {
        w.button(win, { text: `${post.parent ? "Reply: " : ""}${post.title}`, onClick: () => { selected = post.id; if (!post.body) { Entropy.P2P.command({ action: "fetch", publication: post.id }); poll(); } } });
        w.label(win, { text: `${post.author.slice(0, 12)} - ${post.availability}` });
        if (post.id !== selected) continue;
        if (post.body) w.label(win, { text: post.body });
        else w.button(win, { text: "Download / retry", onClick: () => { Entropy.P2P.command({ action: "fetch", publication: post.id }); poll(); } });
        w.button(win, { text: "Reply", onClick: () => { replyTo = post.id; title = `Re: ${post.title}`; } });
        if (post.author === state.author) w.button(win, { text: "Withdraw my post", onClick: () => { Entropy.P2P.command({ action: "withdraw", publication: post.id }); poll(); } });
        if (state.isMaintainer) {
            w.button(win, { text: "Remove publication", onClick: () => { Entropy.P2P.command({ action: "remove", publication: post.id }); poll(); } });
            w.button(win, { text: "Block payload", onClick: () => { Entropy.P2P.command({ action: "block", content: post.content }); poll(); } });
            w.button(win, { text: "Ban author", onClick: () => { Entropy.P2P.command({ action: "ban", author: post.author }); poll(); } });
        }
    }

    if (state.isMaintainer) w.button(win, { text: state.memberPublishing ? "Close member publishing" : "Open member publishing", onClick: () => { Entropy.P2P.command({ action: "policy", open: !state.memberPublishing }); poll(); } });
}

// addon.onUpdate((time: number) => update(time));
addon.onUpdatePlus("Global", (time: number) => update(time));

addon.onInit(() => {
    const saved = addon.IO.load();

    if (saved) { room = saved.room; maintainer = saved.maintainer; groupCode = saved.groupCode; tracker = saved.tracker || ""; nodeId = saved.nodeId; port = String(saved.port); peers = Array.isArray(saved.peers) ? JSON.stringify(saved.peers) : ""; advertiseAddress = saved.advertiseAddress || ""; }
    
    // A persisted config (the fake demo seeds one on first launch) joins immediately, so a single
    // launch drops you into a ready room. Leaving still returns to the manual join form.
    if (saved && saved.room && saved.maintainer) join(saved);
    
    const win = Entropy.UI.createTab({ title: "P2P Forum", onRender: () => render(win) });
});

addon.onCleanup(() => Entropy.P2P.stop());