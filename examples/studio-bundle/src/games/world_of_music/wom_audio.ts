// World of Music's sound, all synthesized with Entropy.Audio.playNote. Every Tone sings in its
// own register and timbre as it goes, like a bird; each friend plays an instrument (marimba,
// flute, handpan, drum, kalimba); each island has a slow pentatonic score in its own key. Sounds
// in the world are placed: panned by bearing from the camera and muffled with distance.
// Every call is guarded: no audio device just means silence.

import { SPECIES, type SpeciesId, type LevelDef } from "./wom_data";
import type { V3 } from "../nebula/nk_math";

type Note = Parameters<typeof Entropy.Audio.playNote>[0];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const AIR = { reverbMix: 0.35, reverbRoomSize: 26, reverbTime: 3.2 };

export class Sound {
    enabled = true;
    master = 0.7;
    played = 0;
    private last: Record<string, number> = {};
    private now = 0;
    private barAt = 0;
    private bar = 0;
    private ear: { pos: V3; yaw: number } = { pos: [0, 0, 0], yaw: 0 };

    private queue: { at: number; n: Note }[] = [];
    /** Plays `n` after `delay` seconds (arpeggios, calls); 0 plays now. */
    private later(delay: number, n: Note): void { if (delay <= 0) this.play(n); else if (this.enabled) this.queue.push({ at: this.now + delay, n }); }
    private play(n: Note): void {
        if (!this.enabled) return;
        try { Entropy.Audio.playNote({ ...n, gain: (n.gain ?? 0.5) * this.master }); this.played++; } catch { this.enabled = false; }
    }
    private limit(id: string, gap: number): boolean {
        if (this.now - (this.last[id] ?? -99) < gap) return false;
        this.last[id] = this.now;
        return true;
    }
    /** Pan and muffle for a sound at `at`, and its loudness (0 when too far to hear). */
    private place(at: V3, reach = 45): { pan: number; muffle: number; k: number } {
        const dx = at[0] - this.ear.pos[0], dz = at[2] - this.ear.pos[2], d = Math.hypot(dx, dz);
        const bearing = Math.atan2(dx, dz) - this.ear.yaw;
        return { pan: Math.max(-1, Math.min(1, -Math.sin(bearing) * Math.min(1, d / 6))), muffle: Math.min(0.9, d / reach), k: Math.max(0, 1 - d / reach) };
    }

    /** The score, called every frame: island key, how tense it is (0 calm .. 1 a fight). */
    step(time: number, level: LevelDef, tension: number, ear: { pos: V3; yaw: number }): void {
        this.now = time;
        this.ear = ear;
        if (this.queue.length) { const due = this.queue.filter(q => q.at <= time); this.queue = this.queue.filter(q => q.at > time); for (const q of due) this.play(q.n); }
        const { tonic, mode } = level.key;
        const barLen = 3.2;
        if (time >= this.barAt) {
            this.barAt = time + barLen;
            const roots = [0, 3, 4, 2];
            const root = mode[roots[this.bar % 4] % mode.length];
            this.bar++;
            // A soft pad of three tones from the mode, and a bass note.
            [0, 2, 4].forEach((k, i) => {
                const deg = (roots[(this.bar - 1) % 4] + k) % mode.length;
                const m = tonic + mode[deg] + (roots[(this.bar - 1) % 4] + k >= mode.length ? 12 : 0);
                this.play({ freq: mtof(m), waveform: "triangle", duration: barLen * 1.1, attack: 0.9, decay: 0.8, sustain: 0.5, release: 1.6, gain: 0.05, cutoff: 1500 + tension * 1400, pan: (i - 1) * 0.3, ...AIR });
            });
            this.play({ freq: mtof(tonic - 12 + root), waveform: "sine", duration: barLen, attack: 0.05, decay: 1.2, sustain: 0.3, release: 0.8, gain: 0.16 });
            if (tension > 0.3) {
                // Under threat a low pulse and a hand drum come in.
                for (let k = 0; k < 4; k++) this.later((k * barLen) / 4, { freq: k % 2 ? 180 : 90, waveform: k % 2 ? "tom" : "kick", duration: 0.25, gain: 0.12 * tension });
            }
        }
    }

    /** A Tone's call: two or three quick notes up or down its scale, bird-fashion. */
    chirp(species: SpeciesId, at: V3, note: number): void {
        const { k, pan, muffle } = this.place(at, 38);
        if (k <= 0 || !this.limit(`chirp-${species}`, 0.18)) return;
        const v = SPECIES[species].voice, n = v.notes;
        const seq = note % 2 ? [n[note], n[(note + 2) % n.length] + 12] : [n[note] + 12, n[(note + 1) % n.length] + 12, n[note] + 12];
        seq.forEach((m, i) => this.later(i * (0.07 + 0.03 / v.chirp), { freq: mtof(m) * (1 + (i === seq.length - 1 ? 0.02 * v.chirp : 0)), waveform: v.wave, duration: 0.09 + 0.04 / v.chirp, attack: 0.004, decay: 0.07, sustain: 0.2, release: 0.07, gain: 0.07 * k, cutoff: 2400 + v.chirp * 2000, pan, muffle, ...AIR }));
    }

    /** A friend's instrument. */
    instrument(kind: string, midi: number, at: V3): void {
        const { k, pan, muffle } = this.place(at, 42);
        if (k <= 0) return;
        const f = mtof(midi);
        switch (kind) {
            case "marimba":
                this.play({ freq: f, waveform: "sine", duration: 0.55, attack: 0.002, decay: 0.45, sustain: 0, release: 0.3, gain: 0.16 * k, pan, muffle, ...AIR });
                this.play({ freq: f * 4, waveform: "sine", duration: 0.12, attack: 0.001, decay: 0.08, sustain: 0, release: 0.05, gain: 0.04 * k, pan, muffle });
                break;
            case "flute":
                this.play({ freq: f * 2, waveform: "sine", duration: 0.5, attack: 0.06, decay: 0.2, sustain: 0.7, release: 0.25, gain: 0.08 * k, pan, muffle, ...AIR });
                this.play({ freq: f * 2, waveform: "noise", duration: 0.25, attack: 0.03, decay: 0.15, sustain: 0.1, release: 0.1, gain: 0.012 * k, cutoff: f * 4, pan, muffle });
                break;
            case "handpan":
                this.play({ freq: f, waveform: "sine", duration: 1.4, attack: 0.004, decay: 1.2, sustain: 0.1, release: 0.9, gain: 0.13 * k, pan, muffle, ...AIR });
                this.play({ freq: f * 2.01, waveform: "sine", duration: 0.8, attack: 0.004, decay: 0.6, sustain: 0, release: 0.5, gain: 0.05 * k, pan, muffle });
                break;
            case "drum":
                this.play({ freq: 120 + (midi % 5) * 30, waveform: midi % 3 ? "tom" : "clap", duration: 0.2, gain: 0.16 * k, pan, muffle });
                break;
            default:
                this.play({ freq: f * 2, waveform: "triangle", duration: 0.7, attack: 0.002, decay: 0.6, sustain: 0, release: 0.4, gain: 0.1 * k, pan, muffle, ...AIR });
        }
    }

    /** Tom's Prism Pipe: five notes, a breathy reed. */
    pipe(note: number, level: LevelDef): void {
        const { tonic, mode } = level.key;
        const m = tonic + 12 + mode[note % mode.length];
        this.play({ freq: mtof(m), waveform: "triangle", duration: 0.45, attack: 0.03, decay: 0.2, sustain: 0.6, release: 0.3, gain: 0.14, cutoff: 3200, ...AIR });
        this.play({ freq: mtof(m) * 2, waveform: "sine", duration: 0.35, attack: 0.05, decay: 0.2, sustain: 0.3, release: 0.2, gain: 0.04, ...AIR });
    }
    /** A jam partner's note in call-and-response (louder than ambient). */
    jamNote(kind: string, note: number, level: LevelDef): void {
        const { tonic, mode } = level.key;
        this.instrument(kind, tonic + 12 + mode[note % mode.length], this.ear.pos);
    }

    shot(at: V3, foe: boolean): void {
        const { k, pan, muffle } = this.place(at, 35);
        if (k <= 0 || !this.limit(foe ? "shot-foe" : "shot", 0.08)) return;
        if (foe) this.play({ freq: 160, waveform: "saw", duration: 0.25, attack: 0.002, decay: 0.2, sustain: 0, release: 0.1, gain: 0.09 * k, cutoff: 900, pan, muffle });
        else this.play({ freq: 1500 + Math.random() * 300, waveform: "square", duration: 0.07, attack: 0.001, decay: 0.05, sustain: 0, release: 0.04, gain: 0.04 * k, cutoff: 5000, pan, muffle });
    }
    hit(at: V3, foe: boolean): void {
        const { k, pan, muffle } = this.place(at, 35);
        if (k <= 0 || !this.limit(foe ? "hit-foe" : "hit", 0.06)) return;
        this.play({ freq: foe ? 220 : 900, waveform: "noise", duration: 0.09, attack: 0.001, decay: 0.07, sustain: 0, release: 0.05, gain: 0.08 * k, cutoff: foe ? 1200 : 4000, pan, muffle });
    }
    fade(at: V3): void { const { k, pan } = this.place(at, 50); this.play({ freq: 660, waveform: "sine", duration: 0.9, attack: 0.01, decay: 0.8, sustain: 0, release: 0.5, gain: 0.1 * Math.max(0.3, k), pan, delayTime: 0.2, delayFeedback: 0.4, delayMix: 0.4, ...AIR }); this.play({ freq: 440, waveform: "sine", duration: 0.9, attack: 0.2, decay: 0.7, sustain: 0, release: 0.5, gain: 0.08, pan }); }
    revived(at: V3): void { const { pan } = this.place(at); [64, 68, 71, 76].forEach((m, i) => this.later(i * 0.06, { freq: mtof(m), waveform: "triangle", duration: 0.3, attack: 0.005, decay: 0.25, sustain: 0, release: 0.2, gain: 0.08, pan, ...AIR })); }
    passed(): void { [72, 67, 64, 60].forEach((m, i) => this.later(i * 0.22, { freq: mtof(m), waveform: "sine", duration: 0.7, attack: 0.02, decay: 0.6, sustain: 0, release: 0.4, gain: 0.07, ...AIR })); }
    ate(at: V3): void { const { k, pan, muffle } = this.place(at, 30); if (k > 0 && this.limit("ate", 0.1)) this.play({ freq: 520, waveform: "sine", duration: 0.12, attack: 0.002, decay: 0.1, sustain: 0, release: 0.05, gain: 0.07 * k, pan, muffle }); }
    split(species: SpeciesId): void { const n = SPECIES[species].voice.notes; [n[0], n[2], n[4], n[4] + 12].forEach((m, i) => this.later(i * 0.07, { freq: mtof(m + 12), waveform: SPECIES[species].voice.wave, duration: 0.18, attack: 0.003, decay: 0.15, sustain: 0, release: 0.1, gain: 0.07, ...AIR })); }
    crate(at: V3): void { const { k, pan, muffle } = this.place(at); this.play({ freq: 80, waveform: "kick", duration: 0.4, gain: 0.3 * Math.max(0.2, k), pan, muffle }); this.play({ freq: 600, waveform: "noise", duration: 0.25, attack: 0.001, decay: 0.2, sustain: 0, release: 0.1, gain: 0.08 * k, cutoff: 2000, pan, muffle }); }
    relic(): void { if (this.limit("relic", 0.08)) this.play({ freq: mtof(84 + Math.floor(Math.random() * 3) * 2), waveform: "sine", duration: 0.3, attack: 0.002, decay: 0.25, sustain: 0, release: 0.2, gain: 0.09, delayTime: 0.11, delayFeedback: 0.3, delayMix: 0.3 }); }
    defeated(at: V3, big: boolean): void { const { k, pan } = this.place(at, 60); this.play({ freq: big ? 40 : 70, waveform: "kick", duration: big ? 1.5 : 0.5, gain: (big ? 0.6 : 0.25) * Math.max(0.3, k), pan }); this.play({ freq: big ? 300 : 500, waveform: "noise", duration: big ? 1.2 : 0.3, attack: 0.001, decay: big ? 1 : 0.25, sustain: 0, release: 0.2, gain: 0.08 * k, cutoff: 1500, pan }); }
    purified(): void { [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => this.later(i * 0.09, { freq: mtof(60 + s), waveform: i % 2 ? "triangle" : "sine", duration: 2.2, attack: 0.02 + i * 0.05, decay: 1.4, sustain: 0.3, release: 1.4, gain: 0.07, ...AIR })); }
    gate(open: boolean): void { this.play({ freq: open ? 220 : 160, waveform: "saw", duration: 0.8, attack: 0.05, decay: 0.6, sustain: 0.2, release: 0.3, gain: 0.07, cutoff: open ? 1800 : 700, ...AIR }); if (open) this.play({ freq: mtof(79), waveform: "sine", duration: 0.6, attack: 0.005, decay: 0.5, sustain: 0, release: 0.3, gain: 0.08, ...AIR }); }
    lever(): void { this.play({ freq: 300, waveform: "tom", duration: 0.25, gain: 0.25 }); this.gate(true); }
    portal(): void { this.play({ freq: 880, waveform: "sine", duration: 0.6, attack: 0.1, decay: 0.4, sustain: 0.2, release: 0.3, gain: 0.07, delayTime: 0.09, delayFeedback: 0.5, delayMix: 0.5, ...AIR }); }
    slam(): void { this.play({ freq: 38, waveform: "kick", duration: 1.6, gain: 0.7 }); this.play({ freq: 120, waveform: "noise", duration: 1.0, attack: 0.01, decay: 0.9, sustain: 0, release: 0.3, gain: 0.1, cutoff: 500 }); }
    hurt(): void { if (this.limit("hurt", 0.25)) this.play({ freq: 110, waveform: "tom", duration: 0.3, gain: 0.3 }); }
    down(): void { [55, 50, 46].forEach((m, i) => this.later(i * 0.25, { freq: mtof(m), waveform: "saw", duration: 0.6, attack: 0.01, decay: 0.5, sustain: 0, release: 0.3, gain: 0.08, cutoff: 900 })); }
    order(ok: boolean, species: SpeciesId | null): void {
        if (!ok) { this.play({ freq: 180, waveform: "square", duration: 0.14, attack: 0.002, decay: 0.12, sustain: 0, release: 0.05, gain: 0.05, cutoff: 900 }); return; }
        const n = species ? SPECIES[species].voice.notes : [72, 76];
        this.play({ freq: mtof(n[0] + 12), waveform: "triangle", duration: 0.1, attack: 0.002, decay: 0.08, sustain: 0, release: 0.05, gain: 0.07 });
        this.later(0.06, { freq: mtof(n[2] + 12), waveform: "triangle", duration: 0.12, attack: 0.002, decay: 0.1, sustain: 0, release: 0.05, gain: 0.06 });
    }
    select(species: SpeciesId): void { if (this.limit("select", 0.05)) this.play({ freq: mtof(SPECIES[species].voice.notes[1] + 12), waveform: "sine", duration: 0.08, attack: 0.002, decay: 0.06, sustain: 0, release: 0.04, gain: 0.05 }); }
    link(): void { [79, 74, 79, 86].forEach((m, i) => this.later(i * 0.08, { freq: mtof(m), waveform: "square", duration: 0.07, attack: 0.002, decay: 0.05, sustain: 0.2, release: 0.03, gain: 0.03, cutoff: 3000 })); }
    jamResult(ok: boolean): void { if (ok) [0, 4, 7].forEach((s, i) => this.later(i * 0.08, { freq: mtof(72 + s), waveform: "sine", duration: 0.25, attack: 0.002, decay: 0.2, sustain: 0, release: 0.1, gain: 0.07 })); else this.play({ freq: 140, waveform: "saw", duration: 0.25, attack: 0.002, decay: 0.2, sustain: 0, release: 0.1, gain: 0.06, cutoff: 600 }); }
    song(): void { [0, 4, 7, 12, 7, 12, 16].forEach((s, i) => this.later(i * 0.12, { freq: mtof(67 + s), waveform: "triangle", duration: 0.35, attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.3, gain: 0.08, ...AIR })); }
    ui(): void { if (this.limit("ui", 0.04)) this.play({ freq: 1320, waveform: "sine", duration: 0.05, attack: 0.001, decay: 0.04, sustain: 0, release: 0.02, gain: 0.04 }); }
    complete(): void { [0, 2, 4, 7, 9, 12, 16, 19, 24].forEach((s, i) => this.later(i * 0.11, { freq: mtof(60 + s), waveform: "triangle", duration: 1.2, attack: 0.01, decay: 0.9, sustain: 0.2, release: 0.8, gain: 0.07, ...AIR })); }
}
