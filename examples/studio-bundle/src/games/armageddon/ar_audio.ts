// Armageddon 2070's sound: synthesized with Entropy.Audio.playNote (noise bursts for gunfire,
// thumps for explosions, a low drone that rises with the fight). Sounds are panned by bearing from
// the listener and muffled with distance; every call is guarded (no audio device = silence).
import type { V3 } from "../nebula/nk_math";

type Note = Parameters<typeof Entropy.Audio.playNote>[0];

export class Sound {
    enabled = true;
    master = 0.6;
    played = 0;
    private now = 0;
    private last: Record<string, number> = {};
    private ear: { pos: V3; yaw: number } = { pos: [0, 0, 0], yaw: 0 };
    private droneAt = 0;

    private play(n: Note): void {
        if (!this.enabled) return;
        try { Entropy.Audio.playNote({ ...n, gain: (n.gain ?? 0.5) * this.master }); this.played++; } catch { this.enabled = false; }
    }
    private gap(id: string, s: number): boolean { if (this.now - (this.last[id] ?? -99) < s) return false; this.last[id] = this.now; return true; }
    /** Whether solid cover stands between two points (set by the addon from the battle's world). */
    occluded: ((a: V3, b: V3) => boolean) | null = null;

    /** Where a sound sits for the listener: inverse-distance loudness (`ref` m is half volume) faded out
     * by `reach`, a strong pan by bearing (a little narrower up close, where both ears hear it), and a
     * low-pass for distance, for sounds behind the listener, and for sounds behind walls. */
    private place(at: V3, reach: number, ref: number): { pan: number; muffle: number; k: number } {
        const dx = at[0] - this.ear.pos[0], dz = at[2] - this.ear.pos[2], d = Math.hypot(dx, dz, at[1] - this.ear.pos[1]);
        if (d >= reach) return { pan: 0, muffle: 1, k: 0 };
        const bearing = Math.atan2(dx, dz) - this.ear.yaw;
        const behind = Math.max(0, -Math.cos(bearing));
        const wall = d > 3 && this.occluded?.(this.ear.pos, at) ? 1 : 0;
        const k = (1 / (1 + d / ref)) * Math.sqrt(1 - d / reach) * (wall ? 0.55 : 1);
        const pan = Math.max(-1, Math.min(1, -Math.sin(bearing) * Math.min(1, 0.35 + d / 6)));
        const muffle = Math.min(0.95, Math.pow(d / reach, 0.6) * 0.75 + behind * 0.3 + wall * 0.35);
        return { pan, muffle, k };
    }

    step(time: number, ear: { pos: V3; yaw: number }, tension: number): void {
        this.now = time; this.ear = ear;
        if (time >= this.droneAt) {
            this.droneAt = time + 4;
            this.play({ freq: 55, waveform: "sawtooth", duration: 4.4, attack: 1.5, decay: 1, sustain: 0.6, release: 1.5, gain: 0.03 + tension * 0.04, cutoff: 220 + tension * 400 });
            this.play({ freq: 82.4, waveform: "triangle", duration: 4.4, attack: 1.5, decay: 1, sustain: 0.5, release: 1.5, gain: 0.02 + tension * 0.03 });
        }
    }

    /** A gunshot. Each weapon has its own voice (VOICE): the crack's pitch, length and brightness, the body's
     * thump, and a low tail for the big rifles; launchers whoosh; the EMR zaps. Unknown sources (vehicle guns,
     * turrets) fall back to light or heavy. */
    shot(at: V3, heavy: boolean, mine: boolean, weapon?: string): void {
        if (!mine && !this.gap(`shot${Math.round(at[0] / 30)}${Math.round(at[2] / 30)}`, 0.05)) return;
        const v = (weapon && VOICE[weapon]) || (heavy ? VOICE.heavy : VOICE.light);
        const { k, pan, muffle } = mine ? { k: 1, pan: 0, muffle: 0 } : this.place(at, v.reach, v.ref);
        if (k <= 0.01) return;
        const g = v.gain * k * (mine ? 1.05 : 0.95);
        if (v.zap) {
            this.play({ freq: 1400, waveform: "square", duration: 0.08, attack: 0.001, decay: 0.07, sustain: 0, release: 0.03, gain: 0.08 * g, cutoff: 5000, pan, muffle });
            this.play({ freq: 330, waveform: "sawtooth", duration: 0.22, attack: 0.001, decay: 0.2, sustain: 0, release: 0.05, gain: 0.12 * g, cutoff: 2600, pan, muffle });
        }
        if (v.whoosh) this.play({ freq: 200, waveform: "noise", duration: 0.9, attack: 0.02, decay: 0.8, sustain: 0.1, release: 0.3, gain: 0.22 * g, cutoff: 1400, pan, muffle });
        this.play({ freq: v.f, waveform: "noise", duration: v.d, attack: 0.001, decay: v.d * 0.8, sustain: 0, release: 0.05, gain: 0.3 * g, cutoff: mine ? v.c * 1.4 : v.c, pan, muffle });
        if (v.kick && (mine || heavy || v.gain > 1.1)) this.play({ freq: v.kick, waveform: "kick", duration: 0.15, gain: 0.24 * g, pan, muffle });
        if (v.tail && (mine || k > 0.25)) this.play({ freq: 60, waveform: "noise", duration: v.tail, attack: 0.01, decay: v.tail * 0.9, sustain: 0, release: 0.2, gain: 0.12 * g, cutoff: 700, pan, muffle: Math.min(0.95, muffle + 0.3) });
    }

    /** The player's weapon handling: magazine out / home, a bolt or pump cycling, a dry trigger, a swap. */
    reload(home: boolean): void { this.play({ freq: home ? 1500 : 900, waveform: "square", duration: 0.03, attack: 0.001, decay: 0.025, sustain: 0, release: 0.01, gain: 0.07, cutoff: 3000 }); this.play({ freq: home ? 220 : 160, waveform: "noise", duration: 0.06, attack: 0.001, decay: 0.05, sustain: 0, release: 0.02, gain: 0.12, cutoff: 2400 }); }
    cycle(pump: boolean): void { this.play({ freq: pump ? 180 : 260, waveform: "noise", duration: pump ? 0.12 : 0.08, attack: 0.002, decay: 0.07, sustain: 0, release: 0.03, gain: 0.14, cutoff: 2600 }); this.play({ freq: pump ? 700 : 1100, waveform: "square", duration: 0.025, gain: 0.05, cutoff: 3000 }); }
    dry(): void { if (this.gap("dry", 0.12)) this.play({ freq: 2400, waveform: "square", duration: 0.02, attack: 0.001, decay: 0.015, sustain: 0, release: 0.01, gain: 0.06, cutoff: 5000 }); }
    swap(): void { this.play({ freq: 300, waveform: "noise", duration: 0.1, attack: 0.005, decay: 0.08, sustain: 0, release: 0.03, gain: 0.08, cutoff: 1800 }); }
    /** Guided launcher: a short beep while locking, a high one once locked. */
    lockTone(locked: boolean): void { this.play({ freq: locked ? 1320 : 880, waveform: "sine", duration: locked ? 0.06 : 0.05, gain: 0.07 }); }
    resupply(): void { this.play({ freq: 520, waveform: "triangle", duration: 0.08, gain: 0.1 }); this.play({ freq: 780, waveform: "triangle", duration: 0.12, gain: 0.08 }); this.reload(true); }

    explode(at: V3, radius: number): void {
        if (!this.gap(`boom${Math.round(at[0] / 20)}${Math.round(at[2] / 20)}`, 0.08)) return;
        const { k, pan, muffle } = this.place(at, 1600, 40 + radius * 8);
        if (k <= 0.01) return;
        const big = Math.min(1, radius / 10);
        this.play({ freq: 45, waveform: "kick", duration: 0.6, gain: (0.3 + big * 0.3) * k, pan, muffle });
        this.play({ freq: 70, waveform: "noise", duration: 0.9 + big, attack: 0.002, decay: 0.7 + big * 0.5, sustain: 0, release: 0.3, gain: (0.2 + big * 0.2) * k, cutoff: 900 + (1 - muffle) * 1500, pan, muffle });
    }

    hit(): void { if (this.gap("hit", 0.04)) this.play({ freq: 1800, waveform: "square", duration: 0.04, attack: 0.001, decay: 0.03, sustain: 0, release: 0.02, gain: 0.08 }); }
    hurt(): void { if (this.gap("hurt", 0.25)) this.play({ freq: 120, waveform: "noise", duration: 0.2, attack: 0.002, decay: 0.15, sustain: 0, release: 0.05, gain: 0.25, cutoff: 600 }); }
    kill(head = false): void { this.play({ freq: 880, waveform: "triangle", duration: 0.1, gain: 0.12 }); this.play({ freq: head ? 1760 : 1320, waveform: "triangle", duration: 0.14, gain: 0.1 }); }
    reward(): void { [0, 4, 7, 12].forEach((s, i) => setTimeoutish(() => this.play({ freq: 440 * Math.pow(2, s / 12), waveform: "sine", duration: 0.25, gain: 0.12 }), i)); }
    capture(ours: boolean): void { this.play({ freq: ours ? 523 : 311, waveform: "sawtooth", duration: 0.5, attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.3, gain: 0.1, cutoff: 1800 }); }
    ui(): void { this.play({ freq: 660, waveform: "sine", duration: 0.05, gain: 0.06 }); }
}

/** A weapon's voice: crack pitch f (Hz), length d (s), brightness c (cutoff Hz), body thump (kick Hz, 0 none),
 * loudness, how far it carries (reach m, half volume at ref m), a low tail (s), a rocket whoosh, an EMR zap. */
interface Voice { f: number; d: number; c: number; kick: number; gain: number; reach: number; ref: number; tail?: number; whoosh?: boolean; zap?: boolean }
const VOICE: Record<string, Voice> = {
    light: { f: 140, d: 0.12, c: 3400, kick: 110, gain: 1, reach: 700, ref: 22 },
    heavy: { f: 90, d: 0.25, c: 2600, kick: 60, gain: 1.1, reach: 1100, ref: 45 },
    W001: { f: 150, d: 0.12, c: 3800, kick: 110, gain: 1, reach: 750, ref: 24 },
    W002: { f: 170, d: 0.1, c: 4200, kick: 120, gain: 0.95, reach: 650, ref: 22 },
    W003: { f: 120, d: 0.16, c: 3300, kick: 95, gain: 1.15, reach: 900, ref: 30, tail: 0.4 },
    W004: { f: 200, d: 0.08, c: 4600, kick: 140, gain: 0.8, reach: 500, ref: 18 },
    W005: { f: 85, d: 0.3, c: 2400, kick: 70, gain: 1.3, reach: 700, ref: 26, tail: 0.5 },
    W006: { f: 125, d: 0.14, c: 3000, kick: 95, gain: 1.1, reach: 900, ref: 28 },
    W007: { f: 70, d: 0.22, c: 2200, kick: 55, gain: 1.35, reach: 1300, ref: 50, tail: 0.6 },
    W008: { f: 95, d: 0.28, c: 3600, kick: 60, gain: 1.4, reach: 1400, ref: 50, tail: 1.1 },
    W009: { f: 115, d: 0.18, c: 3400, kick: 85, gain: 1.2, reach: 1000, ref: 34, tail: 0.5 },
    W010: { f: 55, d: 0.4, c: 2600, kick: 45, gain: 1.6, reach: 1600, ref: 60, tail: 1.4 },
    W011: { f: 210, d: 0.09, c: 4400, kick: 150, gain: 0.85, reach: 500, ref: 18 },
    W012: { f: 230, d: 0.07, c: 4800, kick: 160, gain: 0.75, reach: 450, ref: 16 },
    W013: { f: 60, d: 0.5, c: 1600, kick: 50, gain: 1.3, reach: 1100, ref: 40, tail: 0.7, whoosh: true },
    W014: { f: 60, d: 0.5, c: 1600, kick: 50, gain: 1.3, reach: 1100, ref: 40, tail: 0.7, whoosh: true },
    W015: { f: 70, d: 0.45, c: 1900, kick: 55, gain: 1.25, reach: 1100, ref: 40, tail: 0.6, whoosh: true },
    W016: { f: 160, d: 0.1, c: 3000, kick: 90, gain: 1, reach: 800, ref: 26, zap: true },
    A015: { f: 110, d: 0.12, c: 1100, kick: 70, gain: 1, reach: 500, ref: 18 },
};

/** Arpeggio helper without timers: plays at once with a rising pitch offset (the engine has no setTimeout guarantee). */
function setTimeoutish(fn: () => void, _i: number): void { fn(); }
