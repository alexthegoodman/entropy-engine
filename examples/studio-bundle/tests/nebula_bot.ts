// A simple pilot for Nebula Kingdom's tests: flies the nebula at a point, a body or a creature.
import { Game, NO_INPUT, type NkInput } from "../src/games/nebula/nk_game";
import type { BlastId } from "../src/games/nebula/nk_data";
import { sub, len, dist, type V3 } from "../src/games/nebula/nk_math";

export const DT = 1 / 30;

/** Input that turns toward `to` and thrusts (slower when close, so it does not overshoot). */
export function steer(g: Game, to: V3, extra: Partial<NkInput> = {}): NkInput {
    const p = g.player, d = sub(to, p.pos), l = len(d) || 1;
    const yaw = Math.atan2(d[0], d[2]), pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / l)));
    let dy = yaw - p.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const dp = pitch - p.pitch;
    const aligned = Math.abs(dy) < 0.5 && Math.abs(dp) < 0.5;
    return { ...NO_INPUT, turnX: Math.max(-1, Math.min(1, dy * 4)), turnY: Math.max(-1, Math.min(1, dp * 4)), thrust: aligned ? Math.min(1, l / (p.radius * 4)) : 0, ...extra };
}

/** Steps until `until` is true or `seconds` pass; returns whether it became true. */
export function run(g: Game, seconds: number, input: (g: Game) => NkInput, until: (g: Game) => boolean = () => false): boolean {
    for (let t = 0; t < seconds; t += DT) {
        if (until(g)) return true;
        g.step(DT, input(g));
    }
    return until(g);
}

export function flyTo(g: Game, to: () => V3, within: number, seconds = 120, extra: Partial<NkInput> = {}): boolean {
    return run(g, seconds, x => steer(x, to(), extra), x => dist(x.player.pos, to()) < within);
}

/** Turns on anything hunting it from close by (null when nothing is). */
export function fightBack(g: Game): NkInput | null {
    const p = g.player;
    let near: (typeof g.region.creatures)[number] | null = null;
    for (const c of g.region.creatures) if (c.alive && !c.hidden && c.state === "hunt" && c.target === -1 && dist(c.pos, p.pos) < p.radius * 16 + c.radius && (!near || dist(c.pos, p.pos) < dist(near.pos, p.pos))) near = c;
    if (!near) return null;
    const inp = steer(g, near.pos, { fire: true, pulse: dist(near.pos, p.pos) < p.radius * 8, blastPick: blastFor(g, near) });
    inp.thrust = 0;
    return inp;
}

/** Flies to a keyed body and siphons it to nothing. */
export function mine(g: Game, key: string, seconds = 240): boolean {
    const body = () => g.region.bodies.find(b => b.key === key);
    return run(g, seconds, x => { const b = body(); const f = fightBack(x); if (f) return f; return b ? steer(x, b.pos, { siphon: true, surge: dist(x.player.pos, b.pos) > b.radius + x.player.radius * 20 }) : NO_INPUT; }, () => !body());
}

/** The blast a sensible player picks for a foe: glass needs the Sunthread (or shards). */
export function blastFor(g: Game, foe: { species: { trait?: string } }): BlastId {
    if (foe.species.trait === "reflect") return g.hasBlast("beam") ? "beam" : "shard";
    return "lance";
}

/** Hunts every creature of a group with the Lance (and the Pulse when it has it). */
export function clear(g: Game, group: string, seconds = 400): boolean {
    const left = () => g.region.creatures.filter(c => c.alive && c.group === group);
    return run(g, seconds, x => {
        const foes = left();
        if (!foes.length) return NO_INPUT;
        let near = foes[0];
        for (const c of foes) if (dist(c.pos, x.player.pos) < dist(near.pos, x.player.pos)) near = c;
        const d = dist(near.pos, x.player.pos);
        const inp = steer(x, near.pos, { fire: d < x.player.radius * 60, pulse: d < x.player.radius * 8, blastPick: blastFor(x, near) });
        if (d < x.player.radius * 12) inp.thrust = 0;
        return inp;
    }, () => left().length === 0);
}

/** Plays every goal of the current region the way a (sensible, not clever) player would. */
export function playRegion(g: Game, optional = false): boolean {
    const nearest = <T extends { pos: V3 }>(items: T[]): T | null => { let best: T | null = null; for (const it of items) if (!best || dist(it.pos, g.player.pos) < dist(best.pos, g.player.pos)) best = it; return best; };
    for (let pass = 0; pass < 3; pass++) {
        for (const goal of g.goals) {
            if (goal.done || (goal.def.optional && !optional)) continue;
            const d = goal.def;
            switch (d.type) {
                case "absorb": run(g, 300, x => { const b = nearest(x.region.bodies.filter(q => q.kind === d.kind)); return b ? steer(x, b.pos) : NO_INPUT; }, () => goal.done); break;
                case "mine": for (const k of d.keys ?? []) mine(g, k, 400); break;
                case "clear": clear(g, d.group ?? "", 600); break;
                case "defeat": { const c = g.region.creatures.find(q => q.key === d.key); if (c) { c.group ||= `solo-${d.key}`; clear(g, c.group, 600); } break; }
                case "defend": run(g, 600, x => { const foe = nearest(x.region.creatures.filter(q => q.alive && q.wave >= 0)); if (!foe) return NO_INPUT; const dd = dist(foe.pos, x.player.pos); const inp = steer(x, foe.pos, { fire: dd < x.player.radius * 60, surge: dd > x.player.radius * 40 }); if (dd < x.player.radius * 12) inp.thrust = 0; return inp; }, () => goal.done); break;
                case "tribute": { const e = g.region.creatures.find(q => q.species.id === "envoy" && q.faction === d.faction); if (e) { flyTo(g, () => e.pos, e.radius + g.player.radius * 5, 120); g.step(DT, { ...NO_INPUT, tribute: true }); } break; }
                case "standing": for (const e of g.region.creatures.filter(q => q.species.id === "envoy")) { flyTo(g, () => e.pos, e.radius + g.player.radius * 5, 200, { surge: true }); for (let i = 0; i < 4 && g.standing(e.faction) < 25; i++) { g.step(DT, { ...NO_INPUT, tribute: true }); run(g, 3, () => NO_INPUT); } } break;
                case "sling": {
                    const h = g.region.holes.find(q => q.key === d.hole)!;
                    // Fly at a point beside the hole, inside its ergosphere, and on out the far side.
                    run(g, 240, x => {
                        const to = sub(h.pos, x.player.pos), l = len(to);
                        const side: V3 = [-to[2] / l, 0, to[0] / l];
                        const aim: V3 = [h.pos[0] + side[0] * h.radius * 1.9 + (to[0] / l) * h.radius * 6, h.pos[1], h.pos[2] + side[2] * h.radius * 1.9 + (to[2] / l) * h.radius * 6];
                        if (l > h.radius * 6) { const f = fightBack(x); if (f) return f; }
                        return steer(x, aim, { surge: true });
                    }, () => goal.done);
                    break;
                }
                case "feed": {
                    const h = g.region.holes.find(q => q.key === d.hole)!;
                    // Keep the hole between you and the pack: hunters fly straight at you, and so into it.
                    run(g, 900, x => {
                        const p = x.player;
                        const foe = nearest(x.region.creatures.filter(q => q.alive && q.species.menace && q.species.attack === "ram"));
                        // None left: more are on their way. Wait for them clear of the hole.
                        if (!foe) return dist(p.pos, h.pos) < h.radius * 4 ? steer(x, [p.pos[0] * 2 - h.pos[0], p.pos[1] * 2 - h.pos[1], p.pos[2] * 2 - h.pos[2]]) : NO_INPUT;
                        // Not noticed yet: go and be noticed.
                        if (foe.state !== "hunt" || foe.target !== -1) return steer(x, foe.pos, { fire: dist(foe.pos, p.pos) < p.radius * 50 });
                        const out = sub(h.pos, foe.pos), l = len(out) || 1;
                        const post: V3 = [h.pos[0] + (out[0] / l) * h.radius * 3.3, h.pos[1] + (out[1] / l) * h.radius * 3.3, h.pos[2] + (out[2] / l) * h.radius * 3.3];
                        // Never cut through the hole to get there: go round it.
                        if (dist(p.pos, h.pos) < h.radius * 2.6) return steer(x, [p.pos[0] * 2 - h.pos[0], p.pos[1] * 2 - h.pos[1], p.pos[2] * 2 - h.pos[2]]);
                        return steer(x, post, { surge: dist(p.pos, post) > p.radius * 30 });
                    }, () => goal.done);
                    break;
                }
                case "lure": {
                    if (goal.locked) break;
                    const h = g.region.holes.find(q => q.key === d.hole)!;
                    const target = () => (d.to === "rift" ? g.region.rift!.pos : g.region.holes.find(q => q.key === d.to)?.pos ?? h.pos);
                    // Keep the target between you and the hole, and stay ahead of it.
                    run(g, 1200, x => {
                        const t = target(), along = sub(t, h.pos), l = len(along) || 1;
                        const lead = Math.max(h.radius * 5, x.player.radius * 12);
                        const post: V3 = [t[0] + (along[0] / l) * lead, t[1] + (along[1] / l) * lead, t[2] + (along[2] / l) * lead];
                        const f = fightBack(x); if (f && dist(x.player.pos, h.pos) > h.radius * 6) return f;
                        return steer(x, post, { surge: dist(x.player.pos, post) > x.player.radius * 30 });
                    }, () => goal.done);
                    break;
                }
            }
        }
        if (g.goals.every(q => q.done || (q.def.optional && !optional))) break;
    }
    run(g, 1, () => NO_INPUT);
    return g.regionComplete;
}
