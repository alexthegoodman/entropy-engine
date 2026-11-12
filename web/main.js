// Loads the Entropy engine's WebAssembly and starts one of the Rhai apps compiled into it.
// This is the page's only script: the app itself is Rhai, run by the engine inside the WASM.
// Pick the app with ?app=<name> (default: nebula-kingdom).

import init, { apps, start } from "./pkg/entropy_engine.js";

const status = document.getElementById("entropy-status");
const say = (text, state = "loading") => { status.textContent = text; status.dataset.state = state; };

try {
    if (!navigator.gpu) {
        say("This browser has no WebGPU. Try a recent Chrome, Edge or Safari, or Firefox with WebGPU enabled.", "error");
    } else {
        await init();
        const app = new URLSearchParams(location.search).get("app") || "nebula-kingdom";
        if (!apps().includes(app)) throw new Error(`No app "${app}". This build has: ${apps().join(", ")}`);
        document.title = app.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
        start(app, "entropy-canvas");
        say("", "running");
    }
} catch (e) {
    say(String(e?.message ?? e), "error");
}
