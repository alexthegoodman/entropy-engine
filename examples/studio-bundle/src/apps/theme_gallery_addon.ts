// Theme Gallery - a small standalone EntropyApp built to exercise Entropy.UI.setTheme, the
// addon-facing API (added alongside this addon: src/entropy_gui/style.rs's `ThemeDescriptor`/
// `style_from_theme`, src/deno/addon_ops.rs's `op_ui_set_theme`) for describing entropy_gui's
// Style/Visuals from TypeScript instead of hardcoding it in Rust (the old approach, still
// visible in src/core/egui_theme.rs's "Ember" theme). Every widget in this window - including
// the ones that pick the theme - is themed by the theme it's picking, so the picker restyles
// itself live.

interface ThemeConfig {
    background?: [number, number, number, number];
    surface?: [number, number, number, number];
    surfaceHover?: [number, number, number, number];
    border?: [number, number, number, number];
    text?: [number, number, number, number];
    accent?: [number, number, number, number];
    cornerRadius?: number;
    windowCornerRadius?: number;
    itemSpacing?: number;
    buttonPadding?: [number, number];
}

const addonInfo = {
    name: "Theme Gallery",
    version: "1.0.0",
    description: "Live preview of Entropy.UI.setTheme presets and live color/spacing tweaks",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        ui: true
    }
};

const addon = Entropy.AddonAtom.register(addonInfo);

// "#RRGGBB" -> [r, g, b, a] in 0..1, the format every ThemeConfig color and Widget.colorInput
// expects. Written once here so the presets below read as colors, not byte math.
function hex(h: string, a = 1): [number, number, number, number] {
    const v = parseInt(h.replace("#", ""), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, a];
}

// "Slate" is Entropy.UI.setTheme's own default, so the preset for it is just {} - every field
// falls back inside style_from_theme(). "Ember" reproduces the theme that used to live as
// ~90 lines of hardcoded Rust in src/core/egui_theme.rs; "Nocturne" was that same file's
// mocked-up-but-never-built third direction. "Verdant" is new.
const PRESETS: { name: string; theme: ThemeConfig }[] = [
    { name: "Slate", theme: {} },
    {
        name: "Ember",
        theme: {
            background: hex("#0F0E0D"), surface: hex("#181512"), surfaceHover: hex("#241F19"),
            border: hex("#302A22"), text: hex("#F2EEE7"), accent: hex("#DDA33D"),
            cornerRadius: 10, windowCornerRadius: 12, itemSpacing: 10,
        }
    },
    {
        name: "Nocturne",
        theme: {
            background: hex("#0B0D14"), surface: hex("#121621"), surfaceHover: hex("#1A2030"),
            border: hex("#242C3E"), text: hex("#E8ECF4"), accent: hex("#6C8EEF"),
            cornerRadius: 4, windowCornerRadius: 6, itemSpacing: 8,
        }
    },
    {
        name: "Verdant",
        theme: {
            background: hex("#0D120E"), surface: hex("#151D17"), surfaceHover: hex("#1E2921"),
            border: hex("#28362C"), text: hex("#E9F1EA"), accent: hex("#5CC87A"),
            cornerRadius: 8, windowCornerRadius: 10, itemSpacing: 9,
        }
    },
];

let selectedPreset = 0;
let currentTheme: ThemeConfig = { ...PRESETS[0].theme };
let sampleChecked = true;

function applyTheme() {
    Entropy.UI.setTheme(currentTheme);
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "Theme Gallery",
        width: 320,
        height: 340,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Entropy.UI.setTheme()", bold: true });
    Entropy.UI.Widget.label(win, { text: "Every widget below is live-restyled." });
    Entropy.UI.Widget.separator(win);

    Entropy.UI.Widget.dropdown(win, {
        label: "Preset",
        options: PRESETS.map(p => p.name),
        selectedIndex: selectedPreset,
        onChange: (v) => {
            selectedPreset = parseInt(v as unknown as string, 10);
            currentTheme = { ...PRESETS[selectedPreset].theme };
            applyTheme();
        }
    });

    Entropy.UI.Widget.colorInput(win, {
        label: "Accent",
        color: currentTheme.accent || hex("#3FD1C4"),
        onChange: (c) => {
            currentTheme = { ...currentTheme, accent: c as [number, number, number, number] };
            applyTheme();
        }
    });

    Entropy.UI.Widget.slider(win, {
        label: "Corner Radius",
        value: currentTheme.cornerRadius ?? 6,
        min: 0,
        max: 16,
        onChange: (v) => {
            currentTheme = { ...currentTheme, cornerRadius: Math.round(parseFloat(v as unknown as string)) };
            applyTheme();
        }
    });

    Entropy.UI.Widget.slider(win, {
        label: "Item Spacing",
        value: currentTheme.itemSpacing ?? 8,
        min: 2,
        max: 20,
        onChange: (v) => {
            currentTheme = { ...currentTheme, itemSpacing: parseFloat(v as unknown as string) };
            applyTheme();
        }
    });

    Entropy.UI.Widget.separator(win);
    Entropy.UI.Widget.label(win, { text: "Sample widgets:" });

    Entropy.UI.Widget.button(win, {
        text: "Sample Button",
        onClick: () => Entropy.println("Theme Gallery: sample button clicked")
    });

    Entropy.UI.Widget.checkbox(win, {
        label: "Sample Checkbox",
        value: sampleChecked,
        onChange: (v) => { sampleChecked = v; }
    });
}

addon.onInit(async () => {
    applyTheme();
    setupUI();
});
