import { it } from "vitest";
import { Game, NO_INPUT } from "../src/games/nebula/nk_game";
import { run, steer, mine, clear, flyTo, DT } from "./nebula_bot";
import { dist } from "../src/games/nebula/nk_math";

it("probe cradle", () => {
    const g = new Game();
    const log = (s: string) => { const x = g.summary(); console.log(s, "t", x.time, "r", x.player.radiusKm, "lvl", x.player.level, "coh", x.player.cohesion, "goals", x.goals.map(q => `${q.id}:${q.progress}/${q.total}${q.done ? "*" : ""}`).join(" "), "dispersed", x.stats.dispersed); };
    log("start");
    // motes
    run(g, 200, x => { let best = null as any, bd = 1e99; for (const b of x.region.bodies) if (b.kind === "mote") { const d = dist(b.pos, x.player.pos); if (d < bd) { bd = d; best = b; } } return best ? steer(x, best.pos) : NO_INPUT; }, x => x.goals[0].done);
    log("motes");
    console.log("mine pell", mine(g, "pell")); log("pell");
    console.log("clear", clear(g, "gnawers")); log("clear");
    console.log("mine tam", mine(g, "tam")); log("tam");
    console.log("mine sola", mine(g, "sola")); log("sola");
    console.log(g.summary().complete, g.messages.slice(0, 5));
    void flyTo; void DT;
}, 120000);
