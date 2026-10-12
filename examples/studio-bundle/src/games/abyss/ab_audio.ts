// The Abyss's sound, synthesized (Entropy.Audio.playNote): coil-rifle cracks, the river's light
// hissing through the air and bursting, explosions, rotor thump that swells as a gunship passes,
// the low wind of the deep, and a score of pads, brass-like swells and a few piano notes for the
// cutscenes. Every call is guarded: no audio device just means silence.
//
// Sounds in the world are placed: panned by where they are relative to the camera's right, the
// far ear hearing them a hair later (the engine does that), quieter with distance, and muffled
// when they are behind you or the ground or cover stands between - so a shot tells you where it
// came from.

import type { V3 } from "./ab_world";

type Note = Parameters<typeof Entropy.Audio.playNote>[0];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Sound {
    enabled = true;
    master = 0.8;
    private rotorT = 0;
    private ambientT = 0;
    private musicQueue: { at: number; note: Note }[] = [];
    played = 0;
    /** The listener: where the camera is and which way its right points. */
    private ear: V3 = [0, 0, 0];
    private right: V3 = [1, 0, 0];
    private fwd: V3 = [0, 0, 1];
    /** True when something solid stands between two points (the game's line of sight). */
    occluded: ((a: V3, b: V3) => boolean) | null = null;
    /** The last placement (tests and the state tool read it). */
    lastPlace: { gain: number; pan: number; muffle: number } | null = null;

    /** Where the listener is and looks (every frame, from the camera). */
    setListener(pos: V3, forward: V3): void {
        this.ear = pos;
        const l = Math.hypot(forward[0], forward[2]) || 1;
        this.fwd = [forward[0] / l, 0, forward[2] / l];
        // right = forward x up (facing +Z, right is -X: the world's own handedness).
        this.right = [-this.fwd[2], 0, this.fwd[0]];
    }

    /**
     * A sound at `p`: its gain (distance falloff between `near` and `far`), its pan (-1 left .. 1
     * right), and how muffled it is (behind, far, or with something solid in between).
     */
    place(p: V3, near = 8, far = 260): { gain: number; pan: number; muffle: number } {
        const e = this.ear;
        const dx = p[0] - e[0], dy = p[1] - e[1], dz = p[2] - e[2];
        const d = Math.hypot(dx, dy, dz);
        const gain = d <= near ? 1 : Math.max(0, 1 - (d - near) / (far - near)) ** 1.6;
        const flat = Math.hypot(dx, dz);
        if (flat < 1.5) return (this.lastPlace = { gain, pan: 0, muffle: 0 });
        const side = (dx * this.right[0] + dz * this.right[2]) / flat;
        const ahead = (dx * this.fwd[0] + dz * this.fwd[2]) / flat;
        // Close sounds pan less hard (they fill both ears).
        const pan = side * Math.min(1, 0.55 + flat / 40);
        const behind = Math.max(0, -ahead);
        const blocked = d > 4 && this.occluded ? (this.occluded([e[0], e[1], e[2]], [p[0], p[1] + 0.5, p[2]]) ? 1 : 0) : 0;
        const muffle = Math.min(0.9, behind * 0.3 + blocked * 0.55 + Math.min(1, d / far) * 0.25);
        return (this.lastPlace = { gain, pan, muffle });
    }

    private play(n: Note): void {
        if (!this.enabled) return;
        try { Entropy.Audio.playNote({ ...n, gain: (n.gain ?? 0.5) * this.master }); this.played++; } catch { this.enabled = false; }
    }

    rifle(player: boolean, from: V3, ear: V3): void {
        void ear;
        const pl = player ? { gain: 1, pan: 0, muffle: 0 } : this.place(from, 6, 320);
        const g = player ? 1 : pl.gain * 0.6;
        if (g < 0.02) return;
        const sp = { pan: pl.pan, muffle: pl.muffle };
        this.play({ freq: 110, waveform: "kick", duration: 0.12, gain: 0.55 * g, ...sp });
        this.play({ freq: 2400, waveform: "noise", duration: 0.06, cutoff: 6000, attack: 0.001, decay: 0.05, sustain: 0, release: 0.04, gain: 0.32 * g, ...sp });
        // The coils' whine.
        this.play({ freq: player ? 1650 : 1500, waveform: "saw", duration: 0.07, cutoff: 3500, attack: 0.001, decay: 0.06, sustain: 0, release: 0.03, gain: 0.07 * g, reverbMix: 0.25, reverbRoomSize: 30, reverbTime: 1.6, ...sp });
    }

    /** Gain for a sound at `p` (and its pan and muffle, kept in `spot` for the notes that follow). */
    private spot: { pan: number; muffle: number } = { pan: 0, muffle: 0 };
    private at(p: V3, ear: V3, near = 8, far = 260): number {
        void ear;
        const pl = this.place(p, near, far);
        this.spot = { pan: pl.pan, muffle: pl.muffle };
        return pl.gain;
    }

    cast(at: V3, ear: V3): void {
        const g = this.at(at, ear, 10, 200);
        if (g < 0.02) return;
        this.play({ freq: 520, waveform: "sine", duration: 0.6, attack: 0.08, decay: 0.3, sustain: 0.3, release: 0.4, gain: 0.25 * g, delayTime: 0.11, delayFeedback: 0.45, delayMix: 0.35, reverbMix: 0.5, reverbRoomSize: 30, reverbTime: 3, ...this.spot });
        this.play({ freq: 780, waveform: "triangle", duration: 0.5, attack: 0.1, decay: 0.3, sustain: 0.2, release: 0.4, gain: 0.12 * g, reverbMix: 0.5, reverbRoomSize: 30, reverbTime: 3, ...this.spot });
    }

    burst(at: V3, ear: V3, size: number): void {
        const g = this.at(at, ear, 8, 220);
        if (g < 0.02) return;
        this.play({ freq: 60, waveform: "tom", duration: 0.4, gain: 0.5 * g * Math.min(1.5, 0.6 + size), ...this.spot });
        this.play({ freq: 3000, waveform: "noise", duration: 0.5, cutoff: 2600, attack: 0.002, decay: 0.4, sustain: 0, release: 0.2, gain: 0.2 * g, reverbMix: 0.4, reverbRoomSize: 30, reverbTime: 2.5, ...this.spot });
        this.play({ freq: 1040, waveform: "sine", duration: 0.35, attack: 0.001, decay: 0.3, sustain: 0, release: 0.2, gain: 0.1 * g, reverbMix: 0.6, reverbRoomSize: 30, reverbTime: 3.5, ...this.spot });
    }

    explosion(at: V3, ear: V3, power: number): void {
        const g = this.at(at, ear, 20, 1400);
        this.play({ freq: 42, waveform: "kick", duration: 1.2, gain: Math.min(1, 0.5 + power * 0.12) * g, ...this.spot });
        this.play({ freq: 1200, waveform: "noise", duration: 2.2, cutoff: 900, attack: 0.005, decay: 1.6, sustain: 0.1, release: 1.2, gain: 0.45 * g, reverbMix: 0.6, reverbRoomSize: 30, reverbTime: 4, ...this.spot });
    }

    melee(): void {
        this.play({ freq: 5000, waveform: "noise", duration: 0.16, cutoff: 7000, attack: 0.02, decay: 0.12, sustain: 0, release: 0.05, gain: 0.18 });
        this.play({ freq: 880, waveform: "saw", duration: 0.12, cutoff: 2600, attack: 0.01, decay: 0.1, sustain: 0, release: 0.05, gain: 0.05 });
    }

    hurt(): void { this.play({ freq: 80, waveform: "tom", duration: 0.25, gain: 0.45 }); }
    hit(kill: boolean): void { this.play({ freq: kill ? 1320 : 1760, waveform: "sine", duration: 0.05, attack: 0.001, decay: 0.04, sustain: 0, release: 0.02, gain: kill ? 0.18 : 0.1 }); }
    pickup(): void { [72, 76, 79].forEach((m, i) => this.queue(i * 0.07, { freq: mtof(m), waveform: "triangle", duration: 0.18, attack: 0.005, decay: 0.15, sustain: 0, release: 0.1, gain: 0.14, reverbMix: 0.3 })); }
    ui(): void { this.play({ freq: 1200, waveform: "sine", duration: 0.04, gain: 0.08 }); }
    scan(): void {
        this.play({ freq: 300, waveform: "sine", duration: 1.2, attack: 0.02, decay: 1, sustain: 0, release: 0.3, gain: 0.12, delayTime: 0.18, delayFeedback: 0.5, delayMix: 0.4 });
        this.play({ freq: 2400, waveform: "sine", duration: 0.08, gain: 0.08 });
    }
    reload(): void {
        this.play({ freq: 900, waveform: "square", duration: 0.04, cutoff: 2000, gain: 0.08 });
        this.queue(0.8, { freq: 600, waveform: "square", duration: 0.05, cutoff: 1800, gain: 0.1 });
        this.queue(1.1, { freq: 1500, waveform: "saw", duration: 0.3, cutoff: 4000, attack: 0.2, decay: 0.1, sustain: 0, release: 0.05, gain: 0.05 });
    }

    surge(): void {
        // The river answering: a great chord of light.
        for (const [m, d] of [[45, 0], [52, 0.05], [57, 0.1], [64, 0.15], [69, 0.2], [76, 0.3]] as const) {
            this.queue(d, { freq: mtof(m), waveform: "saw", duration: 4, cutoff: 1800 + m * 20, attack: 0.05, decay: 1.5, sustain: 0.4, release: 2.5, gain: 0.12, reverbMix: 0.7, reverbRoomSize: 30, reverbTime: 6 });
        }
        this.play({ freq: 38, waveform: "kick", duration: 1.5, gain: 0.9 });
        this.play({ freq: 6000, waveform: "noise", duration: 3, cutoff: 4000, attack: 0.01, decay: 2.5, sustain: 0, release: 0.5, gain: 0.25, reverbMix: 0.8, reverbRoomSize: 30, reverbTime: 6 });
    }

    /** Kesh's cry: a falling, breathy glide with a ringing overtone, from where it is. */
    cry(at: V3, ear: V3): void {
        const g = this.at(at, ear, 10, 600);
        if (g < 0.02) return;
        this.play({ freq: 520, waveform: "saw", duration: 1.4, cutoff: 1400, resonance: 0.4, attack: 0.08, decay: 0.9, sustain: 0.2, release: 0.6, gain: 0.12 * g, reverbMix: 0.6, reverbRoomSize: 30, reverbTime: 5, ...this.spot });
        this.queue(0.12, { freq: 390, waveform: "sine", duration: 1.2, attack: 0.05, decay: 0.8, sustain: 0.2, release: 0.6, gain: 0.14 * g, reverbMix: 0.6, reverbRoomSize: 30, reverbTime: 5, ...this.spot });
        this.queue(0.35, { freq: 1560, waveform: "triangle", duration: 0.9, attack: 0.1, decay: 0.6, sustain: 0, release: 0.4, gain: 0.05 * g, reverbMix: 0.7, ...this.spot });
        this.play({ freq: 900, waveform: "noise", duration: 1, cutoff: 1200, attack: 0.05, decay: 0.8, sustain: 0, release: 0.3, gain: 0.06 * g, ...this.spot });
    }

    /** One beat of its wings: a deep whump of air. */
    wingbeat(at: V3, ear: V3): void {
        const g = this.at(at, ear, 12, 250);
        if (g < 0.02) return;
        this.play({ freq: 46, waveform: "kick", duration: 0.35, gain: 0.3 * g, ...this.spot });
        this.play({ freq: 300, waveform: "noise", duration: 0.4, cutoff: 420, attack: 0.04, decay: 0.3, sustain: 0, release: 0.1, gain: 0.12 * g, ...this.spot });
    }

    /** A power of the river going off (or a potion drunk). */
    power(id: string, at: V3, ear: V3): void {
        const g = id === "lance" ? this.at(at, ear, 10, 260) : 1;
        if (id !== "lance") this.spot = { pan: 0, muffle: 0 };
        const tone = (m: number, d: number, wave: string, gain: number, delay = 0) => this.queue(delay, { freq: mtof(m), waveform: wave, duration: d, attack: 0.02, decay: d * 0.6, sustain: 0.3, release: d * 0.5, gain: gain * g, reverbMix: 0.55, reverbRoomSize: 30, reverbTime: 4, ...this.spot });
        if (id === "lance") { tone(81, 0.35, "saw", 0.06); tone(69, 0.6, "sine", 0.14); this.play({ freq: 5200, waveform: "noise", duration: 0.25, cutoff: 7000, attack: 0.002, decay: 0.2, sustain: 0, release: 0.05, gain: 0.12 * g, ...this.spot }); }
        else if (id === "ward") [64, 71, 76].forEach((m, i) => tone(m, 1.4, "sine", 0.08, i * 0.06));
        else if (id === "veil") [76, 75, 71].forEach((m, i) => tone(m, 1.2, "triangle", 0.06, i * 0.12));
        else if (id === "mend") [67, 71, 74, 79].forEach((m, i) => tone(m, 0.9, "sine", 0.07, i * 0.09));
        else if (id === "learn") [62, 69, 74, 78, 81, 86].forEach((m, i) => tone(m, 2.2, "saw", 0.05, i * 0.1));
        // (The surge plays its own chord through `surge`.)
    }

    /** A behemoth's breath: a roaring, crackling rush, from its mouth. */
    breath(at: V3, ear: V3): void {
        const g = this.at(at, ear, 12, 380);
        if (g < 0.02) return;
        this.play({ freq: 900, waveform: "noise", duration: 0.6, cutoff: 1400, attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.2, gain: 0.3 * g, ...this.spot });
        this.play({ freq: 70, waveform: "saw", duration: 0.6, cutoff: 260, attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.2, gain: 0.16 * g, ...this.spot });
        this.play({ freq: 4000, waveform: "noise", duration: 0.4, cutoff: 6500, attack: 0.01, decay: 0.3, sustain: 0, release: 0.1, gain: 0.05 * g, ...this.spot });
    }

    /** Alex whistles for Kesh. */
    whistle(): void {
        this.play({ freq: mtof(84), waveform: "sine", duration: 0.25, attack: 0.02, decay: 0.2, sustain: 0.3, release: 0.05, gain: 0.1 });
        this.queue(0.28, { freq: mtof(91), waveform: "sine", duration: 0.4, attack: 0.02, decay: 0.3, sustain: 0.3, release: 0.1, gain: 0.1 });
    }

    /** A quest offered, finished, the chapter done. */
    quest(kind: string): void {
        const notes = kind === "completed" ? [67, 71, 74, 79] : kind === "chapter" ? [62, 69, 74, 78, 81] : [72, 79];
        notes.forEach((m, i) => this.queue(i * 0.11, { freq: mtof(m), waveform: "triangle", duration: 0.6, attack: 0.005, decay: 0.4, sustain: 0.2, release: 0.4, gain: 0.12, reverbMix: 0.4 }));
    }

    /** Called every frame: rotor thump of the nearest aircraft, the wind of the deep, queued music. */
    step(dt: number, time: number, ear: V3, nearestRotor: number, depth: number): void {
        for (let i = this.musicQueue.length - 1; i >= 0; i--) if (this.musicQueue[i].at <= time) { this.play(this.musicQueue[i].note); this.musicQueue.splice(i, 1); }
        this.rotorT -= dt;
        if (nearestRotor < 400 && this.rotorT <= 0) {
            const g = Math.max(0, 1 - nearestRotor / 400) ** 1.5;
            this.play({ freq: 55, waveform: "kick", duration: 0.09, gain: 0.35 * g });
            this.play({ freq: 400, waveform: "noise", duration: 0.08, cutoff: 500, gain: 0.08 * g });
            this.rotorT = 0.105;
        }
        this.ambientT -= dt;
        if (this.ambientT <= 0) {
            // Wind over the rim; a low drone in the deep.
            const deep = Math.min(1, depth / 400);
            this.play({ freq: 600, waveform: "noise", duration: 4.5, cutoff: 380 + 300 * (1 - deep), attack: 1.5, decay: 1, sustain: 0.6, release: 2, gain: 0.05 + 0.03 * (1 - deep) });
            if (deep > 0.3) this.play({ freq: mtof(28 + (Math.floor(time / 4.2) % 2) * 3), waveform: "sine", duration: 4.6, attack: 1.8, decay: 1, sustain: 0.8, release: 2, gain: 0.07 * deep, reverbMix: 0.5, reverbRoomSize: 30, reverbTime: 5 });
            this.ambientT = 4.2;
        }
        void ear;
    }

    private queue(delay: number, note: Note): void { this.musicQueue.push({ at: this.now + delay, note }); }
    private now = 0;
    setTime(t: number): void { this.now = t; }

    /** A cutscene's music cue. */
    cue(name: string): void {
        const pad = (m: number[], at: number, dur: number, gain = 0.08, cutoff = 1400) =>
            m.forEach(n => this.queue(at, { freq: mtof(n), waveform: "saw", duration: dur, cutoff, attack: dur * 0.35, decay: dur * 0.2, sustain: 0.7, release: dur * 0.4, gain, reverbMix: 0.6, reverbRoomSize: 30, reverbTime: 6 }));
        const piano = (m: number, at: number, gain = 0.16) => this.queue(at, { freq: mtof(m), waveform: "triangle", duration: 2.4, attack: 0.004, decay: 1.6, sustain: 0.1, release: 1.2, gain, reverbMix: 0.55, reverbRoomSize: 30, reverbTime: 5 });
        const brass = (m: number, at: number, dur: number, gain = 0.1) => this.queue(at, { freq: mtof(m), waveform: "saw", duration: dur, cutoff: 900, resonance: 0.3, attack: dur * 0.3, decay: dur * 0.3, sustain: 0.6, release: dur * 0.3, gain, reverbMix: 0.5, reverbRoomSize: 30, reverbTime: 5 });
        switch (name) {
            case "opening":
                // D minor, slow and wide; a horn calls over it.
                pad([38, 45, 50, 53], 0, 9); pad([34, 41, 46, 50], 9, 9); pad([36, 43, 48, 52], 18, 9); pad([33, 40, 45, 49], 27, 10);
                brass(57, 4, 3.5); brass(62, 8, 2.5); brass(60, 11, 5); brass(57, 22, 3); brass(65, 25.5, 2.5); brass(64, 28, 6);
                [74, 72, 69, 67, 69].forEach((m, i) => piano(m, 36 + i * 1.6, 0.1));
                pad([38, 45, 50, 57], 38, 12, 0.06, 1100); pad([41, 48, 53, 60], 50, 12, 0.06, 1100);
                break;
            case "city":
                // Something old and beautiful: a raised fourth over the drone.
                pad([43, 50, 55, 59, 62], 0, 10, 0.07, 2000);
                [79, 78, 74, 71, 74, 78].forEach((m, i) => piano(m, 0.5 + i * 1.3, 0.12));
                break;
            case "contact":
                pad([36, 37], 0, 8, 0.07, 700);
                [0, 1.6, 3.2, 4.8].forEach(t => this.queue(t, { freq: 49, waveform: "tom", duration: 0.5, gain: 0.4 }));
                break;
            case "battle":
                for (let i = 0; i < 16; i++) this.queue(i * 0.42, { freq: i % 4 === 0 ? 45 : 60, waveform: i % 4 === 0 ? "kick" : "tom", duration: 0.3, gain: 0.35 });
                brass(50, 0, 1.6, 0.12); brass(49, 1.7, 1.6, 0.12); brass(46, 3.4, 3, 0.12);
                break;
            case "ch2":
                // Nine days on: a colder pad, a slow horn, the firebase's drums far off.
                pad([33, 40, 45, 52], 0, 10, 0.06, 1000); pad([36, 43, 48, 55], 10, 10, 0.06, 1000); pad([31, 38, 43, 50], 20, 10, 0.06, 1000); pad([33, 40, 45, 52], 30, 12, 0.06, 1000);
                brass(57, 11, 4, 0.08); brass(60, 15, 3, 0.08); brass(55, 21, 6, 0.08);
                [0, 2.4, 4.8, 7.2, 9.6].forEach(t => this.queue(t + 20, { freq: 52, waveform: "tom", duration: 0.5, gain: 0.18 }));
                break;
            case "beast":
                // Something wounded and huge: low strings, a wavering high line.
                pad([29, 36, 41], 0, 12, 0.07, 700);
                [76, 77, 76, 72, 71].forEach((m, i) => this.queue(1 + i * 1.8, { freq: mtof(m), waveform: "sine", duration: 2.2, attack: 0.5, decay: 0.8, sustain: 0.5, release: 0.8, gain: 0.07, reverbMix: 0.7, reverbRoomSize: 30, reverbTime: 6 }));
                break;
            case "skybound":
                // Rising: the river's chord opens up and the horns climb with the wings.
                pad([38, 45, 50, 54], 0, 8, 0.07, 1600); pad([43, 50, 55, 59], 8, 8, 0.07, 2000); pad([45, 52, 57, 61, 64], 16, 10, 0.08, 2600);
                brass(57, 6, 2.5, 0.1); brass(62, 8.5, 2.5, 0.1); brass(66, 11, 3, 0.1); brass(69, 15, 6, 0.11);
                [74, 76, 78, 81, 83, 86].forEach((m, i) => piano(m, 16 + i * 0.5, 0.11));
                break;
            case "ending":
                // A lament: piano over a cold pad.
                pad([33, 40, 45, 48], 0, 12, 0.06, 900); pad([29, 36, 41, 45], 12, 12, 0.06, 900); pad([31, 38, 43, 47], 24, 12, 0.06, 900); pad([33, 40, 45, 48], 36, 16, 0.06, 900);
                [69, 72, 76, 74, 72, 69, 67, 69, 64, 65, 67, 64].forEach((m, i) => piano(m, 2 + i * 2.1, 0.13));
                brass(57, 30, 6, 0.08); brass(53, 37, 8, 0.08);
                break;
        }
    }
}
