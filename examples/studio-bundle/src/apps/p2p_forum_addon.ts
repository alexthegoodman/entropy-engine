import { P2pClient } from "./p2p_client.ts";

const addon = Entropy.AddonAtom.register({ name: "p2p-forum", version: "1.0.0", description: "Peer-to-peer rooms and signed text posts", author: ["Entropy Team"], capabilities: { ui: true } });
const client = new P2pClient();
let room = "", maintainer = "", groupCode = "", tracker = "http://127.0.0.1:47110";
let nodeId = "10.9.0.1", port = "47201", peers = "", advertiseAddress = "";
let title = "", body = "", selected = "", replyTo: string | null = null;
let joining = false, started = false;
let publishing: { previous: string | null; title: string; body: string } | null = null;

function join(config?: any) {
    if (!config) {
        let parsed: any[];
        try { parsed = peers.trim() ? JSON.parse(peers) : []; } catch { client.error = "Peers must be a JSON array of {id,address}"; return; }
        config = { room, maintainer, nodeId, port: Number(port), groupCode, tracker: tracker.trim() || null, peers: parsed, advertiseAddress: advertiseAddress.trim() || null };
    }
    joining = client.start(config); started = joining;
    if (joining) addon.IO.save(config);
}
function publish(args?: any) {
    if (publishing) return;
    const submittedTitle = args?.title ?? title, submittedBody = args?.body ?? body;
    const success = client.command({ action: "publish", title: submittedTitle, body: submittedBody, parent: args?.parent ?? replyTo });
    if (success) publishing = { previous: client.state.lastPublication ?? null, title: submittedTitle, body: submittedBody };
}
function render(win: string) {
    client.poll();
    if (client.state.running) joining = false;
    if (publishing && client.state.lastPublication && client.state.lastPublication !== publishing.previous) {
        if (title === publishing.title && body === publishing.body) { title = ""; body = ""; replyTo = null; }
        publishing = null;
    } else if (publishing && client.state.commandError) publishing = null;
    const w = Entropy.UI.Widget;
    w.label(win, { text: "P2P Forum", bold: true });
    if (client.error) w.label(win, { text: client.error });
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
    w.label(win, { text: joining ? "Joining..." : client.state.running ? `Connected as ${client.state.author?.slice(0, 12)}${client.state.isMaintainer ? " (maintainer)" : ""}` : "Service stopped" });
    w.label(win, { text: client.state.trackerOnline ? "Tracker online" : "Tracker offline - local publishing and configured peers remain available" });
    w.button(win, { text: "Sync room", onClick: () => client.command({ action: "sync" }) });
    w.button(win, { text: "Leave room", onClick: () => { client.stop(); joining = started = false; publishing = null; selected = ""; } });
    w.separator(win);
    w.label(win, { text: replyTo ? "Compose reply" : "Compose a post", bold: true });
    w.textInput(win, { id: "forum_title", label: "Title", value: title, onChange: v => title = v });
    w.textInput(win, { id: "forum_body", label: "Body (up to 16 KiB)", value: body, multiline: true, onChange: v => body = v });
    w.button(win, { id: "forum_publish", text: publishing ? "Publishing..." : "Publish", onClick: () => publish() });
    if (replyTo) w.button(win, { text: "Cancel reply", onClick: () => replyTo = null });
    w.separator(win);
    w.label(win, { text: `${client.state.posts.length} posts`, bold: true });
    for (const post of client.state.posts) {
        w.button(win, { text: `${post.parent ? "Reply: " : ""}${post.title}`, onClick: () => { selected = post.id; if (!post.body) client.command({ action: "fetch", publication: post.id }); } });
        w.label(win, { text: `${post.author.slice(0, 12)} - ${post.availability}` });
        if (post.id !== selected) continue;
        if (post.body) w.label(win, { text: post.body });
        else w.button(win, { text: "Download / retry", onClick: () => client.command({ action: "fetch", publication: post.id }) });
        w.button(win, { text: "Reply", onClick: () => { replyTo = post.id; title = `Re: ${post.title}`; } });
        if (post.author === client.state.author) w.button(win, { text: "Withdraw my post", onClick: () => client.command({ action: "withdraw", publication: post.id }) });
        if (client.state.isMaintainer) {
            w.button(win, { text: "Remove publication", onClick: () => client.command({ action: "remove", publication: post.id }) });
            w.button(win, { text: "Block payload", onClick: () => client.command({ action: "block", content: post.content }) });
            w.button(win, { text: "Ban author", onClick: () => client.command({ action: "ban", author: post.author }) });
        }
    }
    if (client.state.isMaintainer) w.button(win, { text: client.state.memberPublishing ? "Close member publishing" : "Open member publishing", onClick: () => client.command({ action: "policy", open: !client.state.memberPublishing }) });
}

addon.onInit(() => {
    const saved = addon.IO.load();
    if (saved) { room = saved.room; maintainer = saved.maintainer; groupCode = saved.groupCode; tracker = saved.tracker || ""; nodeId = saved.nodeId; port = String(saved.port); peers = JSON.stringify(saved.peers); advertiseAddress = saved.advertiseAddress || ""; }
    const win = Entropy.UI.createTab({ title: "P2P Forum", onRender: () => render(win) });
});
addon.onCleanup(() => client.stop());
// Live BDD uses the same handlers as the widgets. Keys never cross this API.
addon.registerTool({ name: "p2p_forum", description: "Join, publish, fetch or moderate a P2P forum; inspect current state", parameters: { type: "object", properties: { action: { type: "string" } } } }, (args: any) => {
    if (args.action === "join") join(args.config);
    else if (args.action === "publish") publish(args);
    else if (args.action === "fetchTitle") {
        client.poll(); const post = client.state.posts.find((p: any) => p.title === args.title);
        if (post) { selected = post.id; client.command({ action: "fetch", publication: post.id }); }
        else client.error = "Post title not found";
    }
    else if (args.action === "select") selected = args.publication;
    else if (args.action === "leave") { client.stop(); started = joining = false; }
    else if (args.action !== "state") client.command(args);
    client.poll(); return { ...client.state, error: client.error };
});
