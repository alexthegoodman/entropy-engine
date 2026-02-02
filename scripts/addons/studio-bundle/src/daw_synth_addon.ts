// DAW Synth Addon
// A mini synthesizer with mastering controls (Gain, Cutoff)

const addon = Entropy.Addon.register({
    name: "Entropy DAW",
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

    addon.UI.createTab({
        title: "🎹 Synth DAW",
        onRender: async () => {
            const tabId = "🎹 Synth DAW"; // This might be brittle if the ID isn't exactly the title for tabs, 
                                          // but op_ui_create_tab uses the title for global tabs usually.
                                          // Actually, ScopedAPI.UI.createTab should ideally return the ID.

            Entropy.UI.Widget.label(tabId, { text: "Synthesizer Settings", bold: true });
            
            Entropy.UI.Widget.slider(tabId, {
                label: "Master Gain",
                min: 0,
                max: 1,
                value: synthParams.gain,
                onChange: (v: number) => { synthParams.gain = v; }
            });

            Entropy.UI.Widget.slider(tabId, {
                label: "Filter Cutoff (Hz)",
                min: 20,
                max: 20000,
                value: synthParams.cutoff,
                onChange: (v: number) => { synthParams.cutoff = v; }
            });

            Entropy.UI.Widget.slider(tabId, {
                label: "Note Duration",
                min: 0.1,
                max: 2.0,
                value: synthParams.duration,
                onChange: (v: number) => { synthParams.duration = v; }
            });

            Entropy.UI.Widget.label(tabId, { text: "Waveform", bold: true });
            
            ["sine", "square", "saw", "noise"].forEach(wf => {
                Entropy.UI.Widget.button(tabId, {
                    text: (synthParams.waveform === wf ? "▶ " : "") + wf.toUpperCase(),
                    onClick: () => { synthParams.waveform = wf as any; }
                });
            });

            Entropy.UI.Widget.label(tabId, { text: "Keyboard", bold: true });

            // Render keys in rows
            const noteNames = Object.keys(NOTES);
            for (let i = 0; i < noteNames.length; i++) {
                const note = noteNames[i];
                Entropy.UI.Widget.button(tabId, {
                    text: note,
                    onClick: () => {
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
