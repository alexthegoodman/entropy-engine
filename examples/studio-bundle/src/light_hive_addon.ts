// Light Hive Addon
// Manages collections of point lights that can be placed in the scene, plus
// engine-wide lighting pipeline controls: a pluggable point-light shading
// function and directional shadow map settings.

import { ComponentAddon } from "./system";

interface LightParams {
    color: [number, number, number];
    intensity: number;
    maxDistance: number;
    falloffExponent: number;
    specularStrength: number;
}

// Every preset must define `fn point_light_contribution(...)` with this exact
// signature - it gets spliced into shaders/lighting.wgsl in place of the built-in
// function. See ENTROPY_CUSTOM_POINT_LIGHT_BEGIN/END in that file for the contract.
const SHADER_PRESETS: Record<string, string> = {
    toon: `
fn point_light_contribution(
    p_light: PointLight, frag_pos: vec3<f32>, N: vec3<f32>, view_dir: vec3<f32>,
    albedo: vec3<f32>, metallic: f32, ao: f32, F0: vec3<f32>, a2: f32, k: f32, NdotV: f32
) -> vec3<f32> {
    let light_vec = p_light.position - frag_pos;
    let distance = length(light_vec);
    let light_dir = light_vec / distance;
    let attenuation = clamp(1.0 - pow(distance / p_light.max_distance, p_light.falloff_exponent), 0.0, 1.0);
    let NdotL = max(dot(N, light_dir), 0.0);

    // Quantize the diffuse term into hard bands instead of a smooth falloff.
    var band: f32;
    if (NdotL > 0.75) { band = 1.0; }
    else if (NdotL > 0.35) { band = 0.6; }
    else if (NdotL > 0.05) { band = 0.25; }
    else { band = 0.0; }

    let halfway = normalize(light_dir + view_dir);
    let spec = pow(max(dot(N, halfway), 0.0), 64.0) * p_light.specular_strength;

    return albedo * p_light.color * p_light.intensity * attenuation * band * ao
        + vec3<f32>(spec) * p_light.color * attenuation;
}
`,
    rim: `
fn point_light_contribution(
    p_light: PointLight, frag_pos: vec3<f32>, N: vec3<f32>, view_dir: vec3<f32>,
    albedo: vec3<f32>, metallic: f32, ao: f32, F0: vec3<f32>, a2: f32, k: f32, NdotV: f32
) -> vec3<f32> {
    let light_vec = p_light.position - frag_pos;
    let distance = length(light_vec);
    let light_dir = light_vec / distance;
    let attenuation = clamp(1.0 - pow(distance / p_light.max_distance, p_light.falloff_exponent), 0.0, 1.0);
    let NdotL = max(dot(N, light_dir), 0.0);

    let diffuse = albedo * p_light.color * p_light.intensity * NdotL * attenuation * ao * 0.5;

    // Reuses the specular-strength slider to control rim tightness instead of a highlight size.
    let rim_power = mix(1.0, 6.0, 1.0 - clamp(p_light.specular_strength, 0.0, 1.0));
    let rim = pow(1.0 - max(NdotV, 0.0), rim_power) * NdotL;

    return diffuse + p_light.color * p_light.intensity * rim * attenuation;
}
`,
    // Deliberately invalid WGSL - references an identifier that doesn't exist. Used to
    // prove the engine's compile-error fallback actually works: this should get rejected
    // by the wgpu validation error scope in build_lighting_pipeline, log an error, and
    // leave whatever pipeline was already running untouched instead of crashing the app.
    broken: `
fn point_light_contribution(
    p_light: PointLight, frag_pos: vec3<f32>, N: vec3<f32>, view_dir: vec3<f32>,
    albedo: vec3<f32>, metallic: f32, ao: f32, F0: vec3<f32>, a2: f32, k: f32, NdotV: f32
) -> vec3<f32> {
    return this_identifier_does_not_exist * 2.0;
}
`
};

// --- Demo scene geometry -----------------------------------------------------
// A small lit "showroom" (ground plane + a few boxes) so point light color,
// falloff, specular and shadows are actually visible against something. Built
// as raw vertex/index data (position3, normal3, uv2, color4 - the engine's
// standard Vertex layout) and spawned through the default PBR mesh pipeline.

function pushQuad(vertices: number[], indices: number[], p0: number[], p1: number[], p2: number[], p3: number[], normal: number[], color: number[]) {
    const base = vertices.length / 12;
    const corners = [p0, p1, p2, p3];
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
        const p = corners[i];
        const uv = uvs[i];
        vertices.push(p[0], p[1], p[2], normal[0], normal[1], normal[2], uv[0], uv[1], color[0], color[1], color[2], color[3]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function buildBoxMesh(center: [number, number, number], size: [number, number, number], color: [number, number, number, number]) {
    const [cx, cy, cz] = center;
    const [hx, hy, hz] = size.map(s => s / 2);
    const vertices: number[] = [];
    const indices: number[] = [];

    pushQuad(vertices, indices, [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz - hz], [1, 0, 0], color); // +X
    pushQuad(vertices, indices, [cx - hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz - hz], [cx - hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz + hz], [-1, 0, 0], color); // -X
    pushQuad(vertices, indices, [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz], [0, 1, 0], color); // +Y
    pushQuad(vertices, indices, [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz - hz], [0, -1, 0], color); // -Y
    pushQuad(vertices, indices, [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz], [0, 0, -1], color); // -Z
    pushQuad(vertices, indices, [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz + hz], [0, 0, 1], color); // +Z

    return { vertices, indices };
}

function buildPlaneMesh(center: [number, number, number], size: number, color: [number, number, number, number]) {
    const [cx, cy, cz] = center;
    const h = size / 2;
    const vertices: number[] = [];
    const indices: number[] = [];
    pushQuad(vertices, indices, [cx - h, cy, cz - h], [cx + h, cy, cz - h], [cx + h, cy, cz + h], [cx - h, cy, cz + h], [0, 1, 0], color);
    return { vertices, indices };
}

function spawnDemoScene() {
    const groundColor: [number, number, number, number] = [0.5, 0.5, 0.52, 1.0];
    const boxColor: [number, number, number, number] = [0.75, 0.75, 0.75, 1.0];

    const ground = buildPlaneMesh([0, 0, 0], 24, groundColor);
    Entropy.Model.createMesh({
        id: "light_hive_demo_ground",
        position: [0, 0, 0],
        vertexData: ground.vertices,
        indexData: ground.indices,
        pipelineId: "default"
    });

    const pedestal = buildBoxMesh([0, 0.5, 0], [2, 1, 2], boxColor);
    Entropy.Model.createMesh({
        id: "light_hive_demo_pedestal",
        position: [0, 0, 0],
        vertexData: pedestal.vertices,
        indexData: pedestal.indices,
        pipelineId: "default"
    });

    // A real, detailed model reads the shading differences (toon banding, rim falloff) far
    // better across its curved surfaces than flat-faced primitives do - loading one requires
    // EntropyApp::with_art_assets_project(id) on the Rust side (see example_light_hive.rs);
    // without it this silently never appears (see the post's failure notes).
    // Model ids get parsed as a UUID internally (rigid-body user_data, art_assets/Model.rs) even
    // when no physics config is requested - a human-readable id panics ("Couldn't extract uuid").
    Entropy.Model.load({
        id: Entropy.generateUUID(),
        path: "Enemy1.glb",
        position: [0, 1, 0],
        scale: [3, 3, 3]
    });
}

class LightHiveAddon extends ComponentAddon<LightParams> {
    protected defaultParams: LightParams = {
        color: [1.0, 1.0, 1.0],
        intensity: 25.0,
        maxDistance: 150.0,
        falloffExponent: 2.0,
        specularStrength: 1.0
    };

    private shaderPreset: "default" | "toon" | "rim" | "broken" = "default";
    private shadowSettings = { mapSize: 1024, bias: 2, slopeScale: 2.0, halfExtent: 2048.0 };

    constructor() {
        super({
            name: "Light Hive",
            version: "1.0.0",
            description: "Point Light Management System",
            author: ["Entropy Team"],
            capabilities: { graphics: true, ui: true }
        });
    }

    protected setup(): void {
        this.initComponentState("Basic Point Light");
        // Keep the original fixed id so existing saved projects referencing
        // componentId "basic_light" keep resolving to this preset.
        this.state.savedComponents[0].id = "basic_light";
        this.state.activeComponentId = "basic_light";

        if (Entropy.Composer) {
            // registerEditor's callback receives an overrideKey that must be
            // applied before spawning anything from inside it - Light Hive is
            // an AddonAtom (getAddonName() always resolves to "__VOID__"
            // without an active override), so without this a spawn triggered
            // from Game Composer's embedded editor would be misattributed.
            // ComponentBuilder's editor() doesn't plumb that second argument
            // through, so this is registered directly instead of via
            // this.component(...).
            Entropy.Composer.registerEditor(this.name, (windowId: string, overrideKey: string) => {
                this.renderSharedEditor(windowId, overrideKey);
            });
            Entropy.Composer.registerRenderer(this.name, (id, params) => this.renderLight(id, params as any));

            // Always available in Game Composer's picker, even on a brand
            // new project with no saved Light Hive data yet to load.
            Entropy.Composer.registerComponent(this.name, "basic_light", "Basic Point Light", this.currentParams);
        }
    }

    // Uses the top-level, "Global"-defaulting Entropy.Lighting API rather than
    // this.Lighting (which tags calls with getAddonName() - "__VOID__" for an
    // AddonAtom outside an active Composer override, and is_render_allowed()
    // silently drops "__VOID__" lights). Both resolve to the Composer override
    // when one is active, so this is a strict superset: it also makes the
    // addon's own standalone tab actually render lights, which this.Lighting
    // never did outside Game Composer.
    private renderLight(id: string, params: LightParams & { _transform?: { position: [number, number, number] } }) {
        const position = params._transform?.position || [0, 0, 0];
        Entropy.Lighting.createPointLight({
            id,
            position,
            color: params.color,
            intensity: params.intensity,
            maxDistance: params.maxDistance,
            falloffExponent: params.falloffExponent ?? 2.0,
            specularStrength: params.specularStrength ?? 1.0
        });
    }

    private removeLight(id: string) {
        Entropy.Lighting.removePointLight(id);
    }

    private refreshPreview() {
        this.renderLight("preview_light", {
            ...this.currentParams,
            _transform: { position: [0, 5, 0] }
        });
    }

    private spawnAtCamera() {
        const [playerPos] = Entropy.Camera.getTransform();
        const spawnPos: [number, number, number] = [playerPos[0], playerPos[1], playerPos[2]];
        this.renderLight(Entropy.generateUUID(), { ...this.currentParams, _transform: { position: spawnPos } });
        Entropy.println(`Spawned light at camera: ${spawnPos}`);
    }

    private applyShaderPreset(preset: "default" | "toon" | "rim" | "broken") {
        this.shaderPreset = preset;
        const source = preset === "default" ? "" : SHADER_PRESETS[preset];
        Entropy.Lighting.setPointLightShader(source);
        Entropy.println(`[Light Hive] Point light shader preset: ${preset}`);
    }

    private applyShadowSettings() {
        Entropy.Lighting.configureShadows(this.shadowSettings);
    }

    // The standalone floating window's UI - uses raw Entropy.UI.Widget calls (not this.tab()'s
    // BoundUI convenience wrapper, which only exists for tabs) since onChange handlers here
    // receive strings the way the underlying ops do.
    private renderMainWindow(win: string) {
        const W = Entropy.UI.Widget;
        W.label(win, { text: "💡 Light Properties", bold: true });
        W.colorInput(win, {
            label: "Color",
            color: [...this.currentParams.color, 1.0],
            onChange: (col: number[]) => { this.currentParams.color = [col[0], col[1], col[2]]; this.refreshPreview(); }
        });
        W.slider(win, { label: "Intensity", value: this.currentParams.intensity, min: 0, max: 200, onChange: (v: string) => { this.currentParams.intensity = parseFloat(v); this.refreshPreview(); } });
        W.slider(win, { label: "Max Distance", value: this.currentParams.maxDistance, min: 1, max: 500, onChange: (v: string) => { this.currentParams.maxDistance = parseFloat(v); this.refreshPreview(); } });
        W.slider(win, { label: "Falloff Exponent", value: this.currentParams.falloffExponent, min: 0.5, max: 6, onChange: (v: string) => { this.currentParams.falloffExponent = parseFloat(v); this.refreshPreview(); } });
        W.slider(win, { label: "Specular Strength", value: this.currentParams.specularStrength, min: 0, max: 4, onChange: (v: string) => { this.currentParams.specularStrength = parseFloat(v); this.refreshPreview(); } });
        W.label(win, { text: "--------------------------------" });

        W.button(win, { text: "✨ Spawn Light", onClick: () => { this.spawnAtCamera(); } });
        W.button(win, { text: "🧹 Remove Preview Light", onClick: () => { this.removeLight("preview_light"); } });

        this.renderComponentUI(win, () => this.refreshPreview());

        W.label(win, { text: "--------------------------------" });
        W.label(win, { text: "🎨 Point Light Shader (plugged into the lighting pipeline)", bold: true });
        W.horizontal(win, () => {
            W.button(win, { text: "Default PBR", onClick: () => this.applyShaderPreset("default") });
            W.button(win, { text: "Toon", onClick: () => this.applyShaderPreset("toon") });
            W.button(win, { text: "Rim Highlight", onClick: () => this.applyShaderPreset("rim") });
        });
        W.button(win, { text: "⚠ Broken shader (test rejection)", onClick: () => this.applyShaderPreset("broken") });
        W.label(win, { text: `Active: ${this.shaderPreset}` });

        W.label(win, { text: "--------------------------------" });
        W.label(win, { text: "🌓 Shadow Settings (directional light)", bold: true });
        W.slider(win, {
            label: "Map Size", value: this.shadowSettings.mapSize, min: 256, max: 2048,
            onChange: (v: string) => { this.shadowSettings.mapSize = Math.round(parseFloat(v) / 256) * 256; this.applyShadowSettings(); }
        });
        W.slider(win, {
            label: "Bias", value: this.shadowSettings.bias, min: 0, max: 10,
            onChange: (v: string) => { this.shadowSettings.bias = Math.round(parseFloat(v)); this.applyShadowSettings(); }
        });
        W.slider(win, {
            label: "Slope Scale", value: this.shadowSettings.slopeScale, min: 0, max: 8,
            onChange: (v: string) => { this.shadowSettings.slopeScale = parseFloat(v); this.applyShadowSettings(); }
        });
        W.slider(win, {
            label: "Half Extent", value: this.shadowSettings.halfExtent, min: 8, max: 4096,
            onChange: (v: string) => { this.shadowSettings.halfExtent = parseFloat(v); this.applyShadowSettings(); }
        });
    }

    // Registered as this addon's Composer editor - rendered inline inside Game Composer's own UI.
    private renderSharedEditor(windowId: string, overrideKey: string) {
        Entropy.UI.Widget.label(windowId, { text: "💡 Light Properties", bold: true });
        Entropy.UI.Widget.colorInput(windowId, {
            label: "Color",
            color: [...this.currentParams.color, 1.0],
            onChange: (col: number[]) => { this.currentParams.color = [col[0], col[1], col[2]]; }
        });
        Entropy.UI.Widget.slider(windowId, {
            label: "Intensity", value: this.currentParams.intensity, min: 0, max: 200,
            onChange: (v: string) => { this.currentParams.intensity = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(windowId, {
            label: "Max Distance", value: this.currentParams.maxDistance, min: 1, max: 500,
            onChange: (v: string) => { this.currentParams.maxDistance = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(windowId, {
            label: "Falloff Exponent", value: this.currentParams.falloffExponent, min: 0.5, max: 6,
            onChange: (v: string) => { this.currentParams.falloffExponent = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(windowId, {
            label: "Specular Strength", value: this.currentParams.specularStrength, min: 0, max: 4,
            onChange: (v: string) => { this.currentParams.specularStrength = parseFloat(v); }
        });
        Entropy.UI.Widget.label(windowId, { text: "--------------------------------" });

        Entropy.UI.Widget.button(windowId, {
            text: "✨ Spawn Temporary Light",
            onClick: () => { this.withAddonContext(overrideKey, () => this.spawnAtCamera()); }
        });
    }

    protected onInit() {
        Entropy.println("Light Hive Initializing...");

        spawnDemoScene();
        this.applyShadowSettings();

        // A bare EntropyApp starts its camera at y=0.5 looking along -Z with nothing in the
        // scene there (see fft_water_addon.ts for the same gotcha) - point it at the demo
        // scene instead of leaving the window black on launch.
        Entropy.Camera.setTransform([14, 10, 18], [0, 2, 0]);

        // A couple of lights on by default so the scene isn't just the flat directional
        // sun - warm key light near the pedestal, cool fill light off to the side.
        this.renderLight("demo_light_warm", { color: [1.0, 0.6, 0.3], intensity: 45, maxDistance: 22, falloffExponent: 2.0, specularStrength: 1.5, _transform: { position: [1, 4, 2] } });
        this.renderLight("demo_light_cool", { color: [0.3, 0.5, 1.0], intensity: 35, maxDistance: 20, falloffExponent: 2.0, specularStrength: 1.0, _transform: { position: [-4, 3, -3] } });

        // A floating window (not this.tab()'s full-window tab panel) so the 3D viewport
        // behind it - the whole point of this example - stays visible instead of being
        // covered edge-to-edge by the controls. Pinned to the top-left corner (x/y are the
        // window's starting position - unset would center it directly over the demo scene).
        const winId = Entropy.UI.createWindow({
            title: "Light Hive",
            width: 360,
            height: 720,
            x: 20,
            y: 20,
            onRender: () => this.renderMainWindow(winId)
        });

        this.registerTool({
            name: "spawn_point_light",
            description: "Spawn a new point light and register it as a component for the Game Composer.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the light (e.g., 'Red Beacon')." },
                    position: { type: "array", items: { type: "number" }, description: "[x, y, z] position." },
                    color: { type: "array", items: { type: "number" }, description: "RGB color." },
                    intensity: { type: "number", description: "Brightness." },
                    maxDistance: { type: "number", description: "Radius." }
                },
                required: ["name", "position"]
            }
        }, (args: any) => {
            Entropy.println("Spawning light component via tool: " + args.name);

            const id = Entropy.generateUUID();
            const params: LightParams = {
                color: args.color || [1.0, 1.0, 1.0],
                intensity: args.intensity || 10.0,
                maxDistance: args.maxDistance || 50.0,
                falloffExponent: 2.0,
                specularStrength: 1.0
            };

            this.state.savedComponents.push({ id, name: args.name, params });
            if (Entropy.Composer) {
                Entropy.Composer.registerComponent(this.name, id, args.name, params);
            }

            this.renderLight(id, { ...params, _transform: { position: args.position } });

            return { success: true, id, name: args.name, addonName: this.name };
        });
    }

    protected onProjectChanged() {
        this.loadFromProject();
    }
}

new LightHiveAddon().registerAtom();
