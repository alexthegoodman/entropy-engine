// Nebula Kingdom's sound, all synthesized (Entropy.Audio.playNote): a slow score of pads and
// glassy bells that changes key with the galaxy, and the game's own sounds - feeding, the
// Lance, lightwaves arriving (creatures speak in light, so what you hear is your own nebula
// ringing with it), the fold. Every call is guarded: no audio device just means silence.

type Note = Parameters<typeof Entropy.Audio.playNote>[0];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const SPACE = { reverbMix: 0.6, reverbRoomSize: 40, reverbTime: 6 };

/** Each galaxy's chords (MIDI, low to high), walked one per bar. */
export const SCORES: Record<string, { bar: number; chords: number[][] }> = {
    lantern: { bar: 7, chords: [[38, 50, 57, 62, 66], [43, 50, 55, 59, 66], [40, 52, 55, 59, 64], [45, 52, 57, 61, 64]] },
    drift: { bar: 6.5, chords: [[36, 48, 55, 58, 62], [41, 48, 53, 57, 60], [34, 46, 53, 58, 62], [39, 46, 51, 55, 58]] },
    pyre: { bar: 6, chords: [[33, 45, 52, 55, 60], [29, 41, 48, 53, 57], [31, 43, 50, 53, 58], [28, 40, 47, 52, 56]] },
    still: { bar: 8, chords: [[37, 49, 56, 61, 64], [33, 45, 52, 57, 61], [42, 49, 54, 57, 61], [35, 47, 54, 59, 62]] },
    crownless: { bar: 6.5, chords: [[40, 52, 59, 64, 68], [45, 52, 57, 61, 68], [42, 54, 57, 61, 66], [47, 54, 59, 63, 66]] },
    hollow: { bar: 9, chords: [[30, 42, 49, 52, 54], [29, 41, 48, 51, 55], [27, 39, 46, 49, 54], [30, 42, 48, 49, 53]] },
};

export class Sound {
    enabled = true;
    master = 0.7;
    played = 0;
    private barAt = 0;
    private chord = 0;
    private bellAt = 0;
    private last: Record<string, number> = {};
    private now = 0;

    private play(n: Note): void {
        if (!this.enabled) return;
        try { Entropy.Audio.playNote({ ...n, gain: (n.gain ?? 0.5) * this.master }); this.played++; } catch { this.enabled = false; }
    }

    /** At most one of `id` every `gap` seconds (a swarm of motes must not be a wall of noise). */
    private limit(id: string, gap: number): boolean {
        if (this.now - (this.last[id] ?? -99) < gap) return false;
        this.last[id] = this.now;
        return true;
    }

    /** The score: called every frame with the galaxy and how tense things are (0 calm .. 1 battle). */
    step(time: number, galaxy: string, tension: number, stride: number): void {
        this.now = time;
        const score = SCORES[galaxy] ?? SCORES.lantern;
        if (time >= this.barAt) {
            this.barAt = time + score.bar;
            const chord = score.chords[this.chord++ % score.chords.length];
            chord.forEach((m, i) => this.play({ freq: mtof(m), waveform: i === 0 ? "sine" : "triangle", duration: score.bar * 1.05, attack: score.bar * 0.35, decay: score.bar * 0.3, sustain: 0.6, release: score.bar * 0.5, gain: (i === 0 ? 0.2 : 0.075), cutoff: 1400 + tension * 1600, pan: (i - 2) * 0.25, ...SPACE }));
            if (tension > 0.4) this.play({ freq: mtof(chord[0] - 12), waveform: "saw", duration: score.bar, attack: 0.4, decay: 1, sustain: 0.5, release: 1.5, gain: 0.09 * tension, cutoff: 320, ...SPACE });
        }
        if (time >= this.bellAt) {
            const chord = score.chords[(this.chord + score.chords.length - 1) % score.chords.length];
            const k = Math.abs(Math.sin(time * 12.9898) * 43758.5453) % 1;
            this.bellAt = time + 1.2 + k * (tension > 0.4 ? 1 : 3.5);
            this.play({ freq: mtof(chord[1 + Math.floor(k * 4)] + 12 + (k > 0.7 ? 12 : 0)), waveform: "sine", duration: 2.4, attack: 0.005, decay: 1.6, sustain: 0, release: 1.4, gain: 0.07, pan: k * 2 - 1, delayTime: 0.37, delayFeedback: 0.5, delayMix: 0.4, ...SPACE });
        }
        if (stride > 0.3 && this.limit("stride", 0.5)) this.play({ freq: 80 + stride * 240, waveform: "noise", duration: 0.7, attack: 0.2, decay: 0.3, sustain: 0.4, release: 0.3, gain: 0.05 * stride, cutoff: 500 + stride * 2500 });
    }

    absorb(size: number): void {
        if (!this.limit("absorb", 0.07)) return;
        const f = 520 + Math.min(1, size) * 500 + (Math.abs(Math.sin(this.now * 91.7)) * 240);
        this.play({ freq: f, waveform: "sine", duration: 0.35, attack: 0.004, decay: 0.25, sustain: 0, release: 0.25, gain: 0.16, ...SPACE });
        this.play({ freq: f * 1.5, waveform: "triangle", duration: 0.25, attack: 0.02, decay: 0.2, sustain: 0, release: 0.2, gain: 0.06, ...SPACE });
    }
    mined(star: boolean): void {
        for (const [i, m] of (star ? [50, 57, 62, 66, 74] : [55, 62, 67, 74]).entries()) this.play({ freq: mtof(m), waveform: "triangle", duration: 2.6, attack: 0.02 + i * 0.07, decay: 1.4, sustain: 0.3, release: 1.6, gain: 0.13, ...SPACE });
        this.play({ freq: 46, waveform: "kick", duration: 1.4, gain: 0.5 });
    }
    siphon(): void { if (this.limit("siphon", 0.22)) this.play({ freq: 140 + (this.now * 37 % 60), waveform: "saw", duration: 0.4, attack: 0.08, decay: 0.2, sustain: 0.4, release: 0.2, gain: 0.05, cutoff: 900, ...SPACE }); }
    lance(): void {
        this.play({ freq: 1250, waveform: "triangle", duration: 0.16, attack: 0.001, decay: 0.12, sustain: 0, release: 0.08, gain: 0.13, cutoff: 5000, reverbMix: 0.3, reverbRoomSize: 30, reverbTime: 2 });
        this.play({ freq: 310, waveform: "sine", duration: 0.12, attack: 0.001, decay: 0.1, sustain: 0, release: 0.06, gain: 0.12 });
    }
    shot(): void { if (this.limit("shot", 0.12)) this.play({ freq: 620, waveform: "saw", duration: 0.14, attack: 0.001, decay: 0.1, sustain: 0, release: 0.08, gain: 0.05, cutoff: 2200, ...SPACE }); }
    impact(): void { if (this.limit("impact", 0.06)) this.play({ freq: 1800, waveform: "noise", duration: 0.12, attack: 0.001, decay: 0.09, sustain: 0, release: 0.06, gain: 0.09, cutoff: 3200 }); }
    hurt(): void { if (this.limit("hurt", 0.15)) { this.play({ freq: 70, waveform: "tom", duration: 0.3, gain: 0.4 }); this.play({ freq: 190, waveform: "saw", duration: 0.25, attack: 0.001, decay: 0.2, sustain: 0, release: 0.1, gain: 0.08, cutoff: 700 }); } }
    death(big: boolean): void {
        this.play({ freq: big ? 38 : 60, waveform: "kick", duration: big ? 1.6 : 0.7, gain: big ? 0.7 : 0.4 });
        this.play({ freq: 900, waveform: "noise", duration: big ? 2 : 0.9, attack: 0.004, decay: big ? 1.4 : 0.6, sustain: 0, release: 0.6, gain: 0.14, cutoff: 1600, ...SPACE });
    }
    pulse(): void {
        this.play({ freq: 52, waveform: "kick", duration: 1, gain: 0.6 });
        this.play({ freq: 220, waveform: "sine", duration: 1.4, attack: 0.005, decay: 1, sustain: 0, release: 0.8, gain: 0.2, ...SPACE });
        this.play({ freq: 2400, waveform: "noise", duration: 0.9, attack: 0.01, decay: 0.7, sustain: 0, release: 0.4, gain: 0.1, cutoff: 4200, ...SPACE });
    }
    flare(): void { for (const m of [45, 57, 64, 69]) this.play({ freq: mtof(m), waveform: "saw", duration: 2.6, attack: 0.15, decay: 0.8, sustain: 0.7, release: 0.8, gain: 0.1, cutoff: 2600, ...SPACE }); }
    /** A lightwave reaching you: two notes, pitched by who sent it. */
    message(kind: string, seed: number): void {
        if (!this.limit("message", 0.3)) return;
        const base = kind === "edict" ? 62 : kind === "distress" ? 70 : 74;
        const second = kind === "distress" ? 6 : kind === "edict" ? 7 : 3 + (seed % 3) * 2;
        this.play({ freq: mtof(base), waveform: "sine", duration: 0.5, attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.5, gain: 0.11, delayTime: 0.22, delayFeedback: 0.4, delayMix: 0.35, ...SPACE });
        this.play({ freq: mtof(base + second), waveform: "sine", duration: 0.7, attack: 0.12, decay: 0.4, sustain: 0.1, release: 0.6, gain: 0.09, delayTime: 0.22, delayFeedback: 0.4, delayMix: 0.35, ...SPACE });
    }
    goal(): void { for (const [i, m] of [62, 69, 74].entries()) this.play({ freq: mtof(m), waveform: "triangle", duration: 1.6, attack: 0.01 + i * 0.12, decay: 0.9, sustain: 0.2, release: 1, gain: 0.14, ...SPACE }); }
    levelup(): void { for (const [i, m] of [57, 62, 66, 69, 74, 78].entries()) this.play({ freq: mtof(m), waveform: "triangle", duration: 2.4, attack: 0.01 + i * 0.09, decay: 1.2, sustain: 0.3, release: 1.6, gain: 0.13, pan: (i - 2.5) * 0.25, ...SPACE }); }
    fold(): void {
        this.play({ freq: 60, waveform: "saw", duration: 2.8, attack: 1.3, decay: 0.6, sustain: 0.6, release: 0.8, gain: 0.2, cutoff: 1800, ...SPACE });
        this.play({ freq: 3000, waveform: "noise", duration: 2.8, attack: 1.3, decay: 0.8, sustain: 0.2, release: 0.6, gain: 0.12, cutoff: 6000, ...SPACE });
        for (const [i, m] of [50, 62, 69, 74, 81].entries()) this.play({ freq: mtof(m), waveform: "sine", duration: 3.4, attack: 0.3 + i * 0.25, decay: 1.5, sustain: 0.3, release: 2, gain: 0.1, ...SPACE });
    }
    torn(): void { this.play({ freq: 30, waveform: "kick", duration: 2.4, gain: 0.9 }); this.play({ freq: 140, waveform: "saw", duration: 2, attack: 0.01, decay: 1.6, sustain: 0, release: 1, gain: 0.2, cutoff: 500, ...SPACE }); }
    ui(): void { this.play({ freq: 880, waveform: "sine", duration: 0.08, attack: 0.001, decay: 0.06, sustain: 0, release: 0.05, gain: 0.08 }); }
    toggle(on: boolean): void { this.play({ freq: on ? 660 : 440, waveform: "triangle", duration: 0.4, attack: 0.02, decay: 0.3, sustain: 0, release: 0.3, gain: 0.1, ...SPACE }); }
}
