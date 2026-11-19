"""True Error asset prep (offline): Meshy GLBs -> what the game loads.

For each model it writes, under assets/true_error/game/:
  <name>.glb          the GLB without its images (geometry, skin, animations) - the game parses it
                      with Entropy.IO.readAsset (te_glb.ts)
  <name>_albedo.png   base color, resized to the model's texture size
  <name>_normal.png   tangent-space normal map, when the model has one
  <name>_mr.png       metallic (blue) / roughness (green), when the model has one

`shrink IN OUT SIZE` instead rewrites a GLB with every image resized to at most SIZE (PNG), for
uploads with a size limit (Meshy's 50 MiB rigging input).

`merge [name...]` first builds models/<name>_anim.glb for the characters (rig + named clips, CLIPS).

Usage (from examples/studio-bundle):
  python tools/te_assets.py merge         # characters' rigs + clips
  python tools/te_assets.py               # every model listed in MODELS
  python tools/te_assets.py ray rifle     # just these
  python tools/te_assets.py kit           # the scenery kit, then te_kit_bounds.ts from its GLBs
  python tools/te_assets.py shrink in.glb out.glb 2048
"""
import io
import json
import os
import struct
import sys

from PIL import Image

ROOT = os.path.join("assets", "true_error")
OUT = os.path.join(ROOT, "game")

# name -> (source GLB, texture size). Ray is the user's own model; the rest come from Meshy
# (assets/true_error/models, see meshy_tasks.json for the task trail).
MODELS = {
    "ray": (os.path.join(ROOT, "models", "ray_anim.glb"), 2048),
    "doctor": (os.path.join(ROOT, "models", "doctor_anim.glb"), 2048),
    "hacked_bot": (os.path.join(ROOT, "models", "hacked_bot_anim.glb"), 2048),
    "rifle": (os.path.join(ROOT, "models", "rifle.glb"), 1024),
    "roller": (os.path.join(ROOT, "models", "roller.glb"), 1024),
    "workbench": (os.path.join(ROOT, "models", "workbench.glb"), 1024),
    "upload_pod": (os.path.join(ROOT, "models", "upload_pod.glb"), 1024),
    "holo_terminal": (os.path.join(ROOT, "models", "holo_terminal.glb"), 1024),
    "battery": (os.path.join(ROOT, "models", "battery.glb"), 512),
    "rubble": (os.path.join(ROOT, "models", "rubble.glb"), 1024),
    "girders": (os.path.join(ROOT, "models", "girders.glb"), 1024),
    "pedestal": (os.path.join(ROOT, "models", "pedestal.glb"), 2048),
    "junk": (os.path.join(ROOT, "models", "junk.glb"), 1024),
    "boiler": (os.path.join(ROOT, "models", "boiler.glb"), 1024),
    "carcass": (os.path.join(ROOT, "models", "carcass.glb"), 1024),
    "tower_a": (os.path.join(ROOT, "models", "tower_a.glb"), 1024),
    "tower_b": (os.path.join(ROOT, "models", "tower_b.glb"), 1024),
    "bridge": (os.path.join(ROOT, "models", "bridge.glb"), 1024),
    "hovercar": (os.path.join(ROOT, "models", "hovercar.glb"), 1024),
    "dark_emitter": (os.path.join(ROOT, "models", "dark_emitter.glb"), 1024),
    "warden": (os.path.join(ROOT, "models", "warden_anim.glb"), 2048),
    "crawler": (os.path.join(ROOT, "models", "crawler.glb"), 1024),
    "archive_rack": (os.path.join(ROOT, "models", "archive_rack.glb"), 1024),
    "reactor": (os.path.join(ROOT, "models", "reactor.glb"), 1024),
    "conduit": (os.path.join(ROOT, "models", "conduit.glb"), 1024),
    # Mission 2, Noctis.
    "hollow": (os.path.join(ROOT, "models", "hollow_anim.glb"), 2048),
    "scavenger": (os.path.join(ROOT, "models", "scavenger_anim.glb"), 2048),
    "vesper": (os.path.join(ROOT, "models", "vesper_anim.glb"), 2048),
    "survivor": (os.path.join(ROOT, "models", "survivor_anim.glb"), 2048),
    "elder": (os.path.join(ROOT, "models", "elder_anim.glb"), 2048),
    "pip": (os.path.join(ROOT, "models", "pip.glb"), 1024),
    "cherub": (os.path.join(ROOT, "models", "cherub.glb"), 1024),
    "scattergun": (os.path.join(ROOT, "models", "scattergun.glb"), 1024),
    "gravity_launcher": (os.path.join(ROOT, "models", "gravity_launcher.glb"), 1024),
    "doctor_buggy": (os.path.join(ROOT, "models", "doctor_buggy.glb"), 1024),
    "crates": (os.path.join(ROOT, "models", "crates.glb"), 1024),
    "radio_set": (os.path.join(ROOT, "models", "radio_set.glb"), 1024),
    "assembly_arm": (os.path.join(ROOT, "models", "assembly_arm.glb"), 1024),
    "body_printer": (os.path.join(ROOT, "models", "body_printer.glb"), 1024),
    "conveyor": (os.path.join(ROOT, "models", "conveyor.glb"), 1024),
    "vat": (os.path.join(ROOT, "models", "vat.glb"), 1024),
    "upload_gate": (os.path.join(ROOT, "models", "upload_gate.glb"), 2048),
    "kiosk": (os.path.join(ROOT, "models", "kiosk.glb"), 1024),
    "statue": (os.path.join(ROOT, "models", "statue.glb"), 1024),
    "barge_hull": (os.path.join(ROOT, "models", "barge_hull.glb"), 2048),
    "signal_mast": (os.path.join(ROOT, "models", "signal_mast.glb"), 1024),
    "lock_gate": (os.path.join(ROOT, "models", "lock_gate.glb"), 1024),
    "water_tank": (os.path.join(ROOT, "models", "water_tank.glb"), 1024),
    "harvest_pod": (os.path.join(ROOT, "models", "harvest_pod.glb"), 1024),
    "lure_beacon": (os.path.join(ROOT, "models", "lure_beacon.glb"), 1024),
    "metro_car": (os.path.join(ROOT, "models", "metro_car.glb"), 1024),
    "cable_nest": (os.path.join(ROOT, "models", "cable_nest.glb"), 1024),
    "rock_spire": (os.path.join(ROOT, "models", "rock_spire.glb"), 1024),
    "wind_turbine": (os.path.join(ROOT, "models", "wind_turbine.glb"), 1024),
    "shack": (os.path.join(ROOT, "models", "shack.glb"), 1024),
}
# The scenery kit (te_dressing.ts): many copies each, so smaller maps for the small pieces.
KIT = {
    "street_lamp": 512, "street_sign": 512, "road_barrier": 512, "guard_rail": 512, "barricade": 1024, "utility_pole": 512,
    "billboard": 1024, "transit_shelter": 1024, "vending_machine": 512, "power_pylon": 1024,
    "trash_pile": 1024, "barrels": 512, "scrap_sheets": 1024, "concrete_slab": 1024, "pipe_section": 512, "cable_spool": 512,
    "dumpster": 512, "duct_section": 512, "office_wreck": 1024, "car_wreck": 1024, "truck_wreck": 1024, "engine_block": 512,
    "cargo_container": 1024, "mars_shrub": 1024, "succulents": 512, "dead_tree": 1024, "fungus_cluster": 512,
    "ruined_building": 2048, "ruined_storefront": 2048, "overpass_span": 1024,
    # The wall kit (some remeshed down, assets/true_error/remesh/).
    "wall_pipes": 512, "breaker_panel": 512, "notice_board": 1024, "wall_screens": 512, "wall_vent": 512, "caged_lamp": 512, "chalkboard": 512,
    "wall_cables": 512, "torn_posters": 1024, "fire_cabinet": 512, "ac_unit": 512, "lockers": 512, "metal_shelf": 1024, "bookcase": 1024, "radiator": 512,
}
MODELS.update({name: (os.path.join(ROOT, "models", f"{name}.glb"), size) for name, size in KIT.items()})
BOUNDS_TS = os.path.join("src", "games", "true_error", "te_kit_bounds.ts")


def read_glb(path):
    data = open(path, "rb").read()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, f"{path}: not a GLB"
    off, doc, binary = 12, None, b""
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            doc = json.loads(chunk.decode("utf8"))
        elif ctype == 0x004E4942:
            binary = chunk
        off += 8 + clen
    return doc, binary


def write_glb(path, doc, views):
    """Repacks the document with `views` (bytes per bufferView index) as its one buffer."""
    blob = bytearray()
    for i, v in enumerate(views):
        while len(blob) % 4:
            blob.append(0)
        doc["bufferViews"][i]["byteOffset"] = len(blob)
        doc["bufferViews"][i]["byteLength"] = len(v)
        doc["bufferViews"][i]["buffer"] = 0
        blob.extend(v)
    while len(blob) % 4:
        blob.append(0)
    doc["buffers"] = [{"byteLength": len(blob)}]
    js = json.dumps(doc, separators=(",", ":")).encode("utf8")
    while len(js) % 4:
        js += b" "
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(blob), 0x004E4942))
        f.write(blob)


def view_bytes(doc, binary, i):
    bv = doc["bufferViews"][i]
    start = bv.get("byteOffset", 0)
    return binary[start: start + bv["byteLength"]]


def image_of(doc, binary, tex_index):
    src = doc["textures"][tex_index]["source"]
    return Image.open(io.BytesIO(view_bytes(doc, binary, doc["images"][src]["bufferView"])))


def strip_images(doc, binary):
    """The document and its bufferViews with every image's view emptied (geometry stays)."""
    image_views = {img["bufferView"] for img in doc.get("images", []) if "bufferView" in img}
    views = [b"" if i in image_views else view_bytes(doc, binary, i) for i in range(len(doc["bufferViews"]))]
    return views


def prepare(name, src, size):
    doc, binary = read_glb(src)
    mat = (doc.get("materials") or [{}])[0]
    pbr = mat.get("pbrMetallicRoughness", {})
    maps = {
        "albedo": pbr.get("baseColorTexture", {}).get("index"),
        "normal": mat.get("normalTexture", {}).get("index"),
        "mr": pbr.get("metallicRoughnessTexture", {}).get("index"),
    }
    os.makedirs(OUT, exist_ok=True)
    written = []
    for kind, tex in maps.items():
        target = os.path.join(OUT, f"{name}_{kind}.png")
        if tex is None:
            if os.path.exists(target):
                os.remove(target)
            continue
        im = image_of(doc, binary, tex).convert("RGB" if kind != "albedo" else "RGBA")
        if max(im.size) > size:
            im = im.resize((size, size), Image.LANCZOS)
        im.save(target, optimize=False)
        written.append(kind)
    write_glb(os.path.join(OUT, f"{name}.glb"), doc, strip_images(doc, binary))
    print(f"{name}: {', '.join(written) or 'no textures'} at {size}")


# Characters: the rig plus every clip from Meshy's walking/running and animate GLBs, merged into
# models/<name>_anim.glb under these names (the animate task returns its actions in request order,
# drive_anims.mjs ACTIONS).
CLIPS = {
    "ray": ("ray_rig.glb", [("ray_walk.glb", ["walk"]), ("ray_run.glb", ["run"]),
            ("ray_actions.glb", ["idle", "combat_idle", "walk_shoot", "walk_back_shoot", "jump", "hit", "death"]),
            ("ray_actions2.glb", ["crouch_walk", "crouch_back", "roll", "roll_crouch", "crouch_reload"]),
            ("ray_crouch_idle.glb", ["crouch_idle"])]),
    "hacked_bot": ("hacked_bot_rig.glb", [("hacked_bot_walk.glb", ["walk"]), ("hacked_bot_run.glb", ["run"]),
                   ("hacked_bot_actions.glb", ["combat_idle", "walk_shoot", "hit", "stun", "death"])]),
    "doctor": ("doctor_rig.glb", [("doctor_walk.glb", ["walk"]), ("doctor_actions.glb", ["idle", "talk", "talk2"])]),
    "warden": ("warden_rig.glb", [("warden_walk.glb", ["walk"]), ("warden_run.glb", ["run"]),
               ("warden_actions.glb", ["combat_idle", "walk_shoot", "hit", "stun", "death", "throw"])]),
    # Mission 2 (assets/true_error/drive_anims_m2.mjs ACTIONS).
    "hollow": ("hollow_rig.glb", [("hollow_walk.glb", ["walk"]), ("hollow_run.glb", ["run"]),
               ("hollow_actions.glb", ["idle", "attack", "scream", "stagger", "hit", "stun", "death"])]),
    "scavenger": ("scavenger_rig.glb", [("scavenger_walk.glb", ["walk"]), ("scavenger_run.glb", ["run"]),
                  ("scavenger_actions.glb", ["combat_idle", "walk_shoot", "hit", "stun", "death", "kneel"])]),
    "vesper": ("vesper_rig.glb", [("vesper_walk.glb", ["walk"]), ("vesper_actions.glb", ["idle", "talk", "talk2", "combat_idle"])]),
    "survivor": ("survivor_rig.glb", [("survivor_walk.glb", ["walk"]), ("survivor_actions.glb", ["idle", "talk", "talk2", "wave"])]),
    "elder": ("elder_rig.glb", [("elder_walk.glb", ["walk"]), ("elder_actions.glb", ["idle", "talk"])]),
}


def merge(name):
    base, clips = CLIPS[name]
    models = os.path.join(ROOT, "models")
    doc, binary = read_glb(os.path.join(models, base))
    views = [view_bytes(doc, binary, i) for i in range(len(doc["bufferViews"]))]
    by_name = {n.get("name"): i for i, n in enumerate(doc["nodes"])}
    doc["animations"] = []
    for path, names in clips:
        full = os.path.join(models, path)
        if not os.path.exists(full):
            print(f"{name}: {path} missing, skipped")
            continue
        cdoc, cbin = read_glb(full)
        copied = {}

        def copy_accessor(i):
            if i in copied:
                return copied[i]
            acc = dict(cdoc["accessors"][i])
            bv = dict(cdoc["bufferViews"][acc["bufferView"]])
            views.append(view_bytes(cdoc, cbin, acc["bufferView"]))
            bv.pop("byteOffset", None)
            bv.pop("target", None)
            doc["bufferViews"].append(bv)
            acc["bufferView"] = len(doc["bufferViews"]) - 1
            doc["accessors"].append(acc)
            copied[i] = len(doc["accessors"]) - 1
            return copied[i]

        for k, anim in enumerate(cdoc.get("animations", [])):
            if k >= len(names):
                break
            samplers = [{"input": copy_accessor(s["input"]), "output": copy_accessor(s["output"]),
                         "interpolation": s.get("interpolation", "LINEAR")} for s in anim["samplers"]]
            channels = []
            for ch in anim["channels"]:
                node = cdoc["nodes"][ch["target"]["node"]].get("name")
                if node in by_name:
                    channels.append({"sampler": ch["sampler"], "target": {"node": by_name[node], "path": ch["target"]["path"]}})
            doc["animations"].append({"name": names[k], "samplers": samplers, "channels": channels})
    out = os.path.join(models, f"{name}_anim.glb")
    write_glb(out, doc, views)
    print(f"{out}: clips {[a['name'] for a in doc['animations']]}")


def kit_bounds():
    """te_kit_bounds.ts: each kit model's box as half extents per meter of its largest extent (x, y,
    z), 0.8 of the GLB's POSITION bounds (Meshy meshes rarely fill their box)."""
    rows = []
    for name in KIT:
        path = os.path.join(OUT, f"{name}.glb")
        if not os.path.exists(path):
            continue
        doc, _ = read_glb(path)
        lo, hi = [1e9] * 3, [-1e9] * 3
        for mesh in doc["meshes"]:
            for prim in mesh["primitives"]:
                acc = doc["accessors"][prim["attributes"]["POSITION"]]
                lo = [min(a, b) for a, b in zip(lo, acc["min"])]
                hi = [max(a, b) for a, b in zip(hi, acc["max"])]
        ext = [h - l for l, h in zip(lo, hi)]
        m = max(ext)
        rows.append(f"    {name}: [{', '.join(f'{0.4 * e / m:.3f}' for e in ext)}],")
    with open(BOUNDS_TS, "w", encoding="utf8", newline="\n") as f:
        f.write("// Generated by tools/te_assets.py kit: each kit model's half extents per meter of its largest\n")
        f.write("// extent (x, y, z), 0.8 of its GLB's bounds. te_dressing.ts sizes collision boxes from these.\n")
        f.write("export const KIT_BOUNDS: Record<string, [number, number, number]> = {\n")
        f.write("\n".join(rows) + "\n};\n")
    print(f"{BOUNDS_TS}: {len(rows)} models")


def shrink(src, dst, size):
    doc, binary = read_glb(src)
    views = [view_bytes(doc, binary, i) for i in range(len(doc["bufferViews"]))]
    for img in doc.get("images", []):
        im = Image.open(io.BytesIO(views[img["bufferView"]]))
        if max(im.size) > size:
            im = im.resize((size, size), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        views[img["bufferView"]] = buf.getvalue()
        img["mimeType"] = "image/png"
    write_glb(dst, doc, views)
    print(f"{dst}: {os.path.getsize(dst) / 1e6:.1f} MB")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "shrink":
        shrink(args[1], args[2], int(args[3]))
        sys.exit(0)
    if args and args[0] == "kit":
        for name in args[1:] or KIT:
            src, size = MODELS[name]
            if os.path.exists(src):
                prepare(name, src, size)
            else:
                print(f"{name}: {src} missing, skipped")
        kit_bounds()
        sys.exit(0)
    if args and args[0] == "merge":
        for name in args[1:] or CLIPS:
            merge(name)
        sys.exit(0)
    for name in args or MODELS:
        src, size = MODELS[name]
        if not os.path.exists(src):
            print(f"{name}: {src} missing, skipped")
            continue
        prepare(name, src, size)
