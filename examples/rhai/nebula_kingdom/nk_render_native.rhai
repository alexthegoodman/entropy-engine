// Nebula Kingdom's Renderer (nk_render.ts) on the engine's native instance batches: the
// TypeScript one packs every instance record in script, which is the inner loop of a frame -
// here each record is one native call. Same pipelines, same World uniform (packWorld, translated),
// same meshes (built natively), same record layout: model matrix, color, params, extra.

fn Renderer__new() {
    let o = obj(#{ __class: "Renderer" });
    o.solidPipeline = "";
    o.glowPipeline = "";
    o.worldBuffer = "";
    o.ready = false;
    o.scratch = floats_f(84.0);
    o
}

fn Renderer__init() {
    let groups = [#{ entries: [
        #{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
        #{ binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "StorageReadOnly" },
    ] }];
    this.solidPipeline = Entropy::Pipeline::create(#{ name: "Nebula Solid", layout: "mesh", pbr: false, vertexShader: G::__V.NEBULA_SOLID_SHADER, fragmentShader: G::__V.NEBULA_SOLID_SHADER, extraBindGroups: groups });
    this.glowPipeline = Entropy::Pipeline::create(#{ name: "Nebula Glow", layout: "mesh", pbr: false, vertexShader: G::__V.NEBULA_GLOW_SHADER, fragmentShader: G::__V.NEBULA_GLOW_SHADER, extraBindGroups: groups, transparent: true, additive: true, doubleSided: true });
    this.worldBuffer = Entropy::Buffer::create(#{ size: 84 * 4, usage: "Uniform" });
    let ns = "nebula-kingdom";
    let meshes = #{
        "sphere-5": Entropy::Mesh::icosphere(5, false), "sphere-4": Entropy::Mesh::icosphere(4, false),
        "sphere-3": Entropy::Mesh::icosphere(3, false), "sphere-2": Entropy::Mesh::icosphere(2, false),
        "sphere-1": Entropy::Mesh::icosphere(1, false), sky: Entropy::Mesh::icosphere(3, true),
        quad: Entropy::Mesh::quad(), cone: Entropy::Mesh::cone(10),
    };
    for key in meshes.keys() { Entropy::MeshCache::put(ns, key + "-v1", meshes[key]); }
    this.solids = instance_batches(#{ namespace: ns, keySuffix: "-v1", pipelineId: this.solidPipeline, worldBuffer: this.worldBuffer, recordFloats: 28, prefix: "nk-solid", idleFrames: 600, initialCapacity: 64 });
    this.glows = instance_batches(#{ namespace: ns, keySuffix: "-v1", pipelineId: this.glowPipeline, worldBuffer: this.worldBuffer, recordFloats: 28, prefix: "nk-glow", idleFrames: 600, initialCapacity: 256 });
    this.ready = true;
}

fn Renderer__begin() { this.solids.begin(); this.glows.begin(); }
fn Renderer__flush() { this.solids.flush(); this.glows.flush(); }

fn Renderer__writeWorld(look) { Entropy::Buffer::write(this.worldBuffer, packWorld(look, this.scratch)); }

/// An opaque mesh: params = [kind, seed, look, integrity].
fn Renderer__solid(mesh, m, color, params, extra) {
    this.solids.add_mat(mesh, m, color, params, extra);
}

/// A piece of light on a quad: color's alpha is its strength; params = [kind, seed, 0, placement].
fn Renderer__glow(m, color, kind, seed, place, extra) {
    this.glows.add_mat("quad", m, color, list([kind, seed ?? 0.0, 0.0, place ?? 0.0]), extra);
}
