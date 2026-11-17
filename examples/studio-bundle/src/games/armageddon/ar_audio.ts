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
    private place(at: V3, reach: number): { pan: number; muffle: number; k: number } {
        const dx = at[0] - this.ear.pos[0], dz = at[2] - this.ear.pos[2], d = Math.hypot(dx, dz);
        const bearing = Math.atan2(dx, dz) - this.ear.yaw;
        return { pan: Math.max(-1, Math.min(1, -Math.sin(bearing) * Math.min(1, d / 8))), muffle: Math.min(0.92, d / reach), k: Math.max(0, 1 - d / reach) };
    }

    step(time: number, ear: { pos: V3; yaw: number }, tension: number): void {
        this.now = time; this.ear = ear;
        if (time >= this.droneAt) {
            this.droneAt = time + 4;
            this.play({ freq: 55, waveform: "sawtooth", duration: 4.4, attack: 1.5, decay: 1, sustain: 0.6, release: 1.5, gain: 0.03 + tension * 0.04, cutoff: 220 + tension * 400 });
            this.play({ freq: 82.4, waveform: "triangle", duration: 4.4, attack: 1.5, decay: 1, sustain: 0.5, release: 1.5, gain: 0.02 + tension * 0.03 });
        }
    }

    shot(at: V3, heavy: boolean, mine: boolean): void {
        const { k, pan, muffle } = this.place(at, heavy ? 900 : 500);
        if (k <= 0 || (!mine && !this.gap(`shot${Math.round(at[0] / 30)}${Math.round(at[2] / 30)}`, 0.05))) return;
        this.play({ freq: heavy ? 90 : 140, waveform: "noise", duration: heavy ? 0.25 : 0.12, attack: 0.001, decay: heavy ? 0.2 : 0.09, sustain: 0, release: 0.05, gain: (mine ? 0.32 : 0.18) * k, cutoff: mine ? 5200 : 2600, pan, muffle });
        if (heavy || mine) this.play({ freq: heavy ? 60 : 110, waveform: "kick", duration: 0.15, gain: (mine ? 0.25 : 0.12) * k, pan, muffle });
    }

    explode(at: V3, radius: number): void {
        const { k, pan, muffle } = this.place(at, 1400);
        if (k <= 0 || !this.gap(`boom${Math.round(at[0] / 20)}${Math.round(at[2] / 20)}`, 0.08)) return;
        const big = Math.min(1, radius / 10);
        this.play({ freq: 45, waveform: "kick", duration: 0.6, gain: (0.3 + big * 0.3) * k, pan, muffle });
        this.play({ freq: 70, waveform: "noise", duration: 0.9 + big, attack: 0.002, decay: 0.7 + big * 0.5, sustain: 0, release: 0.3, gain: (0.2 + big * 0.2) * k, cutoff: 900 + (1 - muffle) * 1500, pan, muffle });
    }

    hit(): void { if (this.gap("hit", 0.04)) this.play({ freq: 1800, waveform: "square", duration: 0.04, attack: 0.001, decay: 0.03, sustain: 0, release: 0.02, gain: 0.08 }); }
    hurt(): void { if (this.gap("hurt", 0.25)) this.play({ freq: 120, waveform: "noise", duration: 0.2, attack: 0.002, decay: 0.15, sustain: 0, release: 0.05, gain: 0.25, cutoff: 600 }); }
    kill(): void { this.play({ freq: 880, waveform: "triangle", duration: 0.1, gain: 0.12 }); this.play({ freq: 1320, waveform: "triangle", duration: 0.14, gain: 0.1 }); }
    reward(): void { [0, 4, 7, 12].forEach((s, i) => setTimeoutish(() => this.play({ freq: 440 * Math.pow(2, s / 12), waveform: "sine", duration: 0.25, gain: 0.12 }), i)); }
    capture(ours: boolean): void { this.play({ freq: ours ? 523 : 311, waveform: "sawtooth", duration: 0.5, attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.3, gain: 0.1, cutoff: 1800 }); }
    ui(): void { this.play({ freq: 660, waveform: "sine", duration: 0.05, gain: 0.06 }); }
}

/** Arpeggio helper without timers: plays at once with a rising pitch offset (the engine has no setTimeout guarantee). */
function setTimeoutish(fn: () => void, _i: number): void { fn(); }
