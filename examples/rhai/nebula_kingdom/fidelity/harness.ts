// The TypeScript side of the fidelity check (deno run -A --unstable-sloppy-imports harness.ts).
import { Game, NO_INPUT, newCampaign } from "../../../studio-bundle/src/games/nebula/nk_game";
const plan = JSON.parse(Deno.readTextFileSync(new URL("./plan.json", import.meta.url)));
const c = newCampaign();
c.region = plan.region;
const game = new Game(c);
const trace: number[] = [];
let events = 0;
for (const ph of plan.phases) {
    for (let i = 0; i < ph.frames; i++) {
        game.step(plan.dt, { ...NO_INPUT, ...ph.input });
        events += game.events.length;
    }
    trace.push(game.player.pos[0], game.player.pos[1], game.player.pos[2], game.campaign.mass, game.player.charge);
}
console.log(JSON.stringify({ summary: game.summary(), trace, events, bodies: game.region.bodies.length, creatures: game.region.creatures.filter(x => x.alive).length }));
