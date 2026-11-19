// True Error's sound, synthesized with Entropy.Audio.playNote: photon bolts (a falling square
// chirp), hits, the Reset Algorithm's rising arpeggio, the dark zone's hum, pickups, footsteps.
// Distance attenuates every positional sound.

type Note = Parameters<typeof Entropy.Audio.playNote>[0];
type V3 = [number, number, number];

export class Sound {
    enabled = true;
    master = 0.8;
    played = 0;
    listener: V3 = [0, 0, 0];

    private play(n: Note, at?: V3): void {
        if (!this.enabled) return;
        let g = (n.gain ?? 0.5) * this.master;
        if (at) g *= 1 / (1 + Math.hypot(at[0] - this.listener[0], at[1] - this.listener[1], at[2] - this.listener[2]) * 0.12);
        if (g < 0.01) return;
        try { Entropy.Audio.playNote({ ...n, gain: g }); this.played++; } catch { this.enabled = false; }
    }

    photon(at: V3, enemy = false): void {
        const f = enemy ? 520 : 880;
        this.play({ freq: f, waveform: "square", duration: 0.09, cutoff: 3200, resonance: 0.3, gain: 0.16, attack: 0.002, decay: 0.08, sustain: 0, release: 0.05 }, at);
        this.play({ freq: f * 0.5, waveform: "saw", duration: 0.12, cutoff: 1400, gain: 0.12, attack: 0.002, decay: 0.1, sustain: 0, release: 0.06 }, at);
    }
    hit(at: V3, metal = true): void {
        this.play({ freq: metal ? 1900 : 300, waveform: "noise", duration: 0.06, cutoff: metal ? 5000 : 1200, gain: 0.22, attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 }, at);
        if (metal) this.play({ freq: 2600 + Math.random() * 800, waveform: "sine", duration: 0.12, gain: 0.06, attack: 0.001, decay: 0.12, sustain: 0, release: 0.08 }, at);
    }
    hurt(): void { this.play({ freq: 140, waveform: "saw", duration: 0.18, cutoff: 900, gain: 0.3, attack: 0.002, decay: 0.15, sustain: 0, release: 0.1 }); }
    disabled(at: V3): void {
        for (let i = 0; i < 4; i++) this.play({ freq: 600 - i * 110, waveform: "square", duration: 0.12, cutoff: 2000, gain: 0.14, attack: 0.002, decay: 0.1, sustain: 0, release: 0.05, delayTime: 0.09 * i, delayMix: 0 }, at);
    }
    reset(at: V3): void {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.play({ freq: f, waveform: "sine", duration: 0.5 + i * 0.1, gain: 0.2, attack: 0.01 + i * 0.08, decay: 0.3, sustain: 0.4, release: 0.4, delayTime: 0.3, delayFeedback: 0.3, delayMix: 0.25 }, at));
    }
    explode(at: V3): void {
        this.play({ freq: 60, waveform: "noise", duration: 0.7, cutoff: 700, gain: 0.6, attack: 0.002, decay: 0.6, sustain: 0, release: 0.3 }, at);
        this.play({ freq: 45, waveform: "kick", duration: 0.5, gain: 0.5 }, at);
    }
    pickup(): void { [880, 1320].forEach((f, i) => this.play({ freq: f, waveform: "sine", duration: 0.18, gain: 0.16, attack: 0.005 + i * 0.06, decay: 0.15, sustain: 0, release: 0.1 })); }
    step(at: V3, heavy = false): void { this.play({ freq: heavy ? 90 : 140, waveform: "tom", duration: 0.08, gain: heavy ? 0.12 : 0.06 }, at); }
    darkHum(strength: number): void { if (strength > 0.05) this.play({ freq: 55, waveform: "saw", duration: 0.3, cutoff: 260, resonance: 0.6, gain: 0.25 * strength, attack: 0.05, decay: 0.2, sustain: 0.5, release: 0.2 }); }
    lens(): void { this.play({ freq: 1500, waveform: "sine", duration: 0.06, gain: 0.1, attack: 0.002, decay: 0.05, sustain: 0, release: 0.03 }); }
    radio(): void { this.play({ freq: 2200, waveform: "noise", duration: 0.12, cutoff: 3500, gain: 0.05, attack: 0.01, decay: 0.1, sustain: 0, release: 0.05 }); }
    /** A machine winding up: a rising whine (the tell to get low or roll). */
    charge(at: V3, heavy = false): void {
        this.play({ freq: heavy ? 180 : 420, waveform: "saw", duration: heavy ? 0.85 : 0.4, cutoff: 1800, resonance: 0.5, gain: heavy ? 0.22 : 0.12, attack: heavy ? 0.6 : 0.3, decay: 0.1, sustain: 0.6, release: 0.08 }, at);
    }
    roll(): void { this.play({ freq: 120, waveform: "noise", duration: 0.25, cutoff: 900, gain: 0.14, attack: 0.02, decay: 0.2, sustain: 0, release: 0.08 }); }
    pounce(at: V3): void { this.play({ freq: 700, waveform: "square", duration: 0.14, cutoff: 2600, gain: 0.12, attack: 0.002, decay: 0.12, sustain: 0, release: 0.05 }, at); }
    orb(at: V3): void {
        this.play({ freq: 70, waveform: "noise", duration: 0.5, cutoff: 900, gain: 0.45, attack: 0.002, decay: 0.45, sustain: 0, release: 0.2 }, at);
        this.play({ freq: 260, waveform: "sine", duration: 0.4, gain: 0.15, attack: 0.002, decay: 0.35, sustain: 0, release: 0.2 }, at);
    }
    door(): void { this.play({ freq: 55, waveform: "saw", duration: 1.4, cutoff: 300, resonance: 0.4, gain: 0.25, attack: 0.1, decay: 0.4, sustain: 0.6, release: 0.4 }); }
    collect(): void { [660, 990, 1320].forEach((f, i) => this.play({ freq: f, waveform: "sine", duration: 0.3, gain: 0.12, attack: 0.005 + i * 0.07, decay: 0.25, sustain: 0, release: 0.15, delayTime: 0.2, delayMix: 0.2 })); }
    breaker(ok: boolean): void {
        this.play({ freq: ok ? 90 : 2400, waveform: ok ? "kick" : "noise", duration: ok ? 0.4 : 0.35, cutoff: 5000, gain: 0.35, attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 });
        if (ok) [220, 330].forEach((f, i) => this.play({ freq: f, waveform: "saw", duration: 1.2, cutoff: 800, gain: 0.1, attack: 0.2 + i * 0.2, decay: 0.5, sustain: 0.4, release: 0.5 }));
    }
    surge(): void {
        this.play({ freq: 40, waveform: "kick", duration: 0.9, gain: 0.6 });
        [110, 165, 220, 330].forEach((f, i) => this.play({ freq: f, waveform: "saw", duration: 2.2, cutoff: 1400, gain: 0.12, attack: 0.05 + i * 0.1, decay: 1, sustain: 0.4, release: 1, delayTime: 0.3, delayFeedback: 0.3, delayMix: 0.3 }));
    }
    hypercube(): void { [220, 330, 440, 660, 880].forEach((f, i) => this.play({ freq: f, waveform: "sine", duration: 3.5, gain: 0.12, attack: 0.6 + i * 0.3, decay: 1, sustain: 0.6, release: 2, delayTime: 0.45, delayFeedback: 0.45, delayMix: 0.35 })); }
}
