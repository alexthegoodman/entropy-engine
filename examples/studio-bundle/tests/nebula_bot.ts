// A simple pilot for Nebula Kingdom's tests: flies the nebula at a point, a body or a creature.
import { Game, NO_INPUT, type NkInput } from "../src/games/nebula/nk_game";
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

/** Flies to a keyed body and siphons it to nothing. */
export function mine(g: Game, key: string, seconds = 240): boolean {
    const body = () => g.region.bodies.find(b => b.key === key);
    return run(g, seconds, x => { const b = body(); return b ? steer(x, b.pos, { siphon: true, surge: dist(x.player.pos, b.pos) > b.radius + x.player.radius * 20 }) : NO_INPUT; }, () => !body());
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
        const inp = steer(x, near.pos, { fire: d < x.player.radius * 60, pulse: d < x.player.radius * 8 });
        if (d < x.player.radius * 12) inp.thrust = 0;
        return inp;
    }, () => left().length === 0);
}
