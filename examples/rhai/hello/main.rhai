// Hello, Rhai: the smallest Entropy script app that uses every part of the runtime - a custom
// WGSL pipeline, a cached mesh drawn instanced from a storage buffer, the camera, UI rects and
// text, keys, the mouse, a note, and the document store.

const SHADER = `
struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
struct World { time: vec4<f32> };
@group(2) @binding(0) var<uniform> world: World;
struct Item { model: mat4x4<f32>, color: vec4<f32>, params: vec4<f32>, extra: vec4<f32> };
@group(2) @binding(1) var<storage, read> items: array<Item>;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) normal: vec3<f32>, @location(1) color: vec4<f32> };
@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec4<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let it = items[ii];
    var o: VOut;
    o.pos = camera.view_proj * it.model * vec4<f32>(position, 1.0);
    o.normal = normalize((it.model * vec4<f32>(normal, 0.0)).xyz);
    o.color = it.color;
    return o;
}
@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
    let light = max(dot(in.normal, normalize(vec3<f32>(0.4, 0.8, 0.5))), 0.0) * 0.8 + 0.2;
    return vec4<f32>(in.color.rgb * light, 1.0);
}
`;

const GROUPS = [#{ entries: [
    #{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
    #{ binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "StorageReadOnly" },
] }];

fn init() {
    this.pipeline = Entropy::Pipeline::create(#{ name: "Hello", layout: "mesh", vertexShader: G::SHADER, fragmentShader: G::SHADER, extraBindGroups: G::GROUPS });
    this.world = Entropy::Buffer::create(#{ size: 16, usage: "Uniform" });
    Entropy::MeshCache::put("hello", "ball", Entropy::Mesh::icosphere(2, false));
    this.batches = instance_batches(#{ namespace: "hello", pipelineId: this.pipeline, worldBuffer: this.world, recordFloats: 28, prefix: "hello" });
    this.time = 0.0;
    this.spin = 1.0;
    this.clicks = 0;
    let saved = Entropy::Store::read("hello.json");
    this.visits = if saved == () { 1 } else { Entropy::Json::parse(saved).visits + 1 };
    try { Entropy::Store::write("hello.json", Entropy::Json::stringify(#{ visits: this.visits })); } catch { }
    Entropy::Lighting::setClearColor([0.02, 0.03, 0.06]);
    Entropy::registerTool("hello_state", "The demo's state");
    print(`hello: visit ${this.visits}`);
}

fn update(dt) {
    this.time += dt * this.spin;
    let t = this.time;
    Entropy::Camera::setTransform([sin(t * 0.2) * 9.0, 4.0, cos(t * 0.2) * 9.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
    Entropy::Camera::setFov(55.0);
    Entropy::Buffer::write(this.world, [t, 0.0, 0.0, 0.0]);
    this.batches.begin();
    for i in 0..64 {
        let a = i.to_float() * 0.4 + t;
        let r = 2.0 + (i % 8).to_float() * 0.5;
        let p = [cos(a) * r, sin(a * 1.7) * 1.5, sin(a) * r];
        let hue = i.to_float() / 64.0;
        this.batches.add_placed("ball", p, [0.35, 0.35, 0.35], [0.5 + 0.5 * cos(hue * 6.28), 0.5 + 0.5 * cos(hue * 6.28 + 2.1), 0.5 + 0.5 * cos(hue * 6.28 + 4.2), 1.0], [0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0]);
    }
    this.batches.flush();

    let size = Entropy::Window::getSize();
    Entropy::UI::clear();
    Entropy::UI::rectStroked(20.0, 20.0, 360.0, 92.0, [0.0, 0.0, 0.0, 0.6], 2.0, [1.0, 1.0, 1.0, 0.3]);
    Entropy::UI::text("HELLO, RHAI", 36.0, 30.0, 330.0, 34.0, 24.0, [1.0, 0.9, 0.6, 1.0], "Bungee", [0.0, 0.0, 0.0, 0.0]);
    Entropy::UI::text(`Space pauses, click to chime. Visit ${this.visits}, clicks ${this.clicks}. ${size[0]}x${size[1]}`, 36.0, 70.0, 330.0, 40.0, 14.0, [0.9, 0.9, 0.95, 1.0], "Play", [0.0, 0.0, 0.0, 0.0]);
}

fn on_key_down(key) {
    if key == " " { this.spin = if this.spin > 0.0 { 0.0 } else { 1.0 }; }
}

fn on_mouse_down(button, x, y) {
    this.clicks += 1;
    Entropy::Audio::playNote(#{ freq: 440.0 + this.clicks.to_float() * 55.0, waveform: "triangle", duration: 0.4, attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.4, gain: 0.3, reverbMix: 0.4 });
}

fn tool_hello_state(args) {
    #{ success: true, time: this.time, clicks: this.clicks, visits: this.visits }
}
