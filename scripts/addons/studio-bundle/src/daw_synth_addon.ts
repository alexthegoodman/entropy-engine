// DAW Synth Addon
// A mini synthesizer with mastering controls (Gain, Cutoff)

const addon = Entropy.Addon.register({
    name: "DAW",
    version: "1.0.0",
    description: "Mini Synth & Mastering DAW",
    author: ["Entropy"],
    capabilities: {
        audio: true,
        ui: true
    }
});

let synthParams = {
    waveform: "sine" as "sine" | "square" | "saw" | "noise",
    duration: 0.5,
    cutoff: 5000,
    gain: 0.2,
};

const NOTES: Record<string, number> = {
    "C4": 261.63,
    "C#4": 277.18,
    "D4": 293.66,
    "D#4": 311.13,
    "E4": 329.63,
    "F4": 349.23,
    "F#4": 369.99,
    "G4": 392.00,
    "G#4": 415.30,
    "A4": 440.00,
    "A#4": 466.16,
    "B4": 493.88,
    "C5": 523.25
};

addon.onInit(async () => {
    Entropy.println("DAW Synth Addon Initializing...");

    const tabId = addon.UI.createTab({
        title: "🎹 Synth DAW",
        onRender: async () => {
            Entropy.UI.Widget.label(tabId, { text: "Synthesizer Settings", bold: true });
            
            Entropy.UI.Widget.slider(tabId, {
                label: "Master Gain",
                min: 0,
                max: 1,
                value: synthParams.gain,
                onChange: (v: string) => { synthParams.gain = parseFloat(v); }
            });

            Entropy.UI.Widget.slider(tabId, {
                label: "Filter Cutoff (Hz)",
                min: 20,
                max: 20000,
                value: synthParams.cutoff,
                onChange: (v: string) => { synthParams.cutoff = parseFloat(v); }
            });

            Entropy.UI.Widget.slider(tabId, {
                label: "Note Duration",
                min: 0.1,
                max: 2.0,
                value: synthParams.duration,
                onChange: (v: string) => { synthParams.duration = parseFloat(v); }
            });

            Entropy.UI.Widget.label(tabId, { text: "Waveform", bold: true });
            
            ["sine", "square", "saw", "noise"].forEach(wf => {
                Entropy.UI.Widget.button(tabId, {
                    text: (synthParams.waveform === wf ? "▶ " : "") + wf.toUpperCase(),
                    onClick: () => { synthParams.waveform = wf as any; }
                });
            });

            Entropy.UI.Widget.label(tabId, { text: "Keyboard", bold: true });

            Entropy.UI.Widget.button(tabId, {
                text: "Play Test Tone",
                onClick: () => { 
                    addon.Audio.playTestTone();
                }
            });

            // Render keys in rows
            const noteNames = Object.keys(NOTES);
            for (let i = 0; i < noteNames.length; i++) {
                const note = noteNames[i];
                Entropy.UI.Widget.button(tabId, {
                    text: note,
                    onClick: () => {
                        Entropy.println("Play it...");
                        addon.Audio.playSynth({
                            freq: NOTES[note],
                            waveform: synthParams.waveform,
                            duration: synthParams.duration,
                            cutoff: synthParams.cutoff,
                            gain: synthParams.gain
                        });
                    }
                });
            }
        }
    });
});
