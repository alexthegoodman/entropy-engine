# CAD foundations

Four CAD apps are planned on one foundation: **Design** (built: [Contour Design](CAD_DESIGN.md)),
then Engineering, Architecture and Electronics. This document describes what they share, and what
each new app is expected to add rather than rebuild.

The foundation has one aim beyond being correct and fast: to be good at the two things CAD tools
are usually worst at, **curves** and **asymmetry**. Both are designed in from the bottom, not
offered as special tools on top.

```
crates/entropy-cad            the kernel: plain Rust, no engine, runs headless (tests, tools, web)
src/deno/cad_ops.rs           Entropy.Cad: sessions, evaluation, spawning meshes, picking, export
examples/studio-bundle/src/apps/cad/
    cad_doc.ts                the document's TypeScript types and editing helpers, undo history
    cad_shader.ts             the viewport look: surfaces (solid, holo, zebra, curvature), line ribbons
    cad_view.ts               the viewport: keeps meshes in step with the document, camera, pointer
examples/studio-bundle/src/apps/cad_design/   the Design app (interaction, panels, samples)
```

## The document

A document is plain JSON: an ordered history of features. The app owns it, which makes undo,
persistence, MCP tools and tests ordinary TypeScript. Nothing derived is stored.

```json
{ "version": 1, "units": "mm", "features": [
  { "id": "s1", "name": "Outline", "type": "sketch", "plane": { "base": "top" },
    "points": [{ "id": "p1", "x": -50, "y": -10 }, "..."],
    "entities": [{ "id": "e1", "type": "spline", "points": ["p1", "p2", "p3", "p4", "p5"], "closed": true,
                   "weights": [1, 1.4, 1, 0.7, 1] }] },
  { "id": "x1", "name": "Pebble", "type": "extrude", "profile": { "sketch": "s1" },
    "forward":  { "distance": 34, "scale": [0.35, 0.5], "shift": [14, 6], "bulge": 0.22 },
    "backward": { "distance": 10, "scale": [0.7, 0.7], "bulge": 0.12 }, "op": "new" } ] }
```

`cad_doc.ts` and `crates/entropy-cad/src/features.rs` are the two halves of this format; change
them together. Unknown keys are ignored by the kernel, so an app may keep its own data on features.

### Sketches

A sketch is points on a plane and the curves between them. **Curves that share a point id are
joined**; that is the whole of how the kernel knows a shape is closed. From it the kernel finds:

- **regions**: closed loops, nested into outer boundaries with holes. A region is named by a `key`
  (the smallest entity id in its loop) that survives edits, so features can refer to it;
- **chains**: open runs of curves joined end to end, which are paths to sweep along;
- **corners**: a join is sharp only if the two curves' tangents differ there, so a line running
  into a tangent arc gives a smooth face, not an edge.

| Entity | Notes |
|---|---|
| `line`, `arc` (through three points), `circle`, `ellipse` | Exact (rational) curves, not polylines. |
| `spline`, `mode: "through"` | Passes through every point, curvature-continuous. `weights` are per-point **tension**: how wide the curve swings through that point, so one side of a shape can be made fuller than the other without adding points. |
| `spline`, `mode: "control"` | A NURBS control polygon; `weights` are how hard each point pulls. |
| `construction: true` | A guide (an axis, a centre line): drawn dashed, never part of a profile. |
| `stroke` | Turns an open curve into a closed outline with independent `left` and `right` half widths and a width scale at `start`, `middle` and `end`. A blade is `0, 1, 0`; a wall thicker inside than out is `left != right`. |

A sketch `plane` is a base plane (`top`, `front`, `side`) with an `offset` and `tiltX`, `tiltY`,
`spin` in degrees. Tipped planes are first-class because lofts between them are the quickest way
to a form that leans.

### Features

Every solid feature carries its own means of breaking symmetry.

| Feature | What it does | Asymmetry built in |
|---|---|---|
| `extrude` | Sweeps regions along the plane normal. | `forward` and `backward` are separate sides, each with `distance`, `scale` [x, y], `shift` [x, y], `twist` and `bulge`. |
| `revolve` | Turns regions about a line in the sketch. | Any `start` and `end` (more than a turn allowed); `squash` to an ellipse; `lobes` and `lobeDepth`; `pitch` for coils; `grow` for shells. |
| `loft` | Skins through sections in different sketches. | Sections need not match in shape, point count, size, or plane; corners are carried exactly; per-section `spin` twists the skin; `ruled` or smooth; `closed`. |
| `sweep` | Carries regions along a path from another sketch. | `twist` along the path; `scaleEnd` and `scaleMid`; open or closed paths. |
| `deform` | `twist`, `bend`, `taper` or `shear` a body along an axis. | `from` and `to` choose the part of the body affected and the direction; taper and shear take two independent cross-axis amounts; `smooth` eases. |
| `mirror` | Reflects a body across a plane. | `scale` and `shift` apply to the reflected half only, in the plane's own axes, so the halves stay attached but need not match. `merge: false` makes it a separate body. |

Solid features have an `op`: `new`, `add`, `cut` or `intersect`, against `target` (a body id) or
the most recent body.

A feature that cannot be built is reported as an **issue** with a plain-language message ("the
profile crosses the axis: keep it to one side"); the rest of the document still evaluates.

## The kernel (`crates/entropy-cad`)

| Module | Contents |
|---|---|
| `nurbs` | `NurbsCurve`: the one exact curve type. Constructors for lines, arcs, ellipses, interpolating and control splines; evaluation with derivatives, signed curvature, adaptive flattening to a chord and angle tolerance, arc length, closest point. |
| `sketch` | The sketch model, region and chain finding, stroke outlines, hit testing and snapping, curvature combs. |
| `mesh` | What bodies evaluate to: triangles with smooth normals, per-face tags (which feature, which part), sharp edges. Swept grids, caps (ear clipping with holes), refinement that follows a deformation, measurement, a BVH for rays and box queries. |
| `boolean` | Union, subtract, intersect. |
| `features` | The document model, `PlaneSpec`, each feature's builder, and `Evaluator`. |
| `export` | Binary STL and OBJ (one group per face). |

Things worth knowing before building on it:

- **Bodies are meshes built from exact curves.** Curves are exact until the moment a feature
  sweeps them; the result is a closed triangle mesh with smooth normals and named faces. There is
  no B-rep (no trimmed NURBS surfaces, no exact fillets) yet. This keeps every operation robust
  and fast, and is the main thing Engineering will need to extend.
- **Every body is closed.** `Mesh::open_edges()` is zero for everything the kernel builds,
  including after booleans, and the tests assert it for every feature and every sample.
- **Booleans** split each triangle along the other body's triangles that reach it, then keep or
  drop each piece by whether it is inside the other body. Faces that lie exactly in the other
  body's surface (a pocket cut flush with a top face, a boss standing on one) are detected
  geometrically and handled by rule rather than left to rounding. A sealing pass closes the
  T-junctions cutting leaves. Cost is near linear: two 256-sided cylinders intersect in about
  20 ms; the Skiff sample (four booleans on curved bodies, 53k triangles) evaluates in
  under half a second.
- **Evaluation is incremental.** `Evaluator` keys every result by what it depends on (the feature,
  the sketches it reads, the body it modifies, the tolerance). Changing one feature rebuilds that
  feature and what follows it on the same body; other bodies are reused untouched, and undo lands
  on meshes that are still cached. Each `Body` has a `key` that changes only when its geometry
  does.
- **Deformers refine only what they bend.** An edge is split while the deformation carries points
  along it away from the straight line between its mapped ends, so a twist subdivides the walls it
  winds and leaves flat caps alone.
- **Tolerance** is a chord distance (default 0.02 units) and a maximum turn between facets
  (default 6 degrees). `draft()` coarsens both for drags.

Run its tests with `cargo test` in `crates/entropy-cad` (unit tests per module, the Design
samples evaluated headlessly, and a doc test).

## `Entropy.Cad`

The engine-side API (typed in `addon.d.ts` as `CadAPI`). A session wraps an `Evaluator` and the
last evaluation:

```ts
const session = Entropy.Cad.open();
const result = Entropy.Cad.evaluate(session, doc, { draft: dragging });
for (const body of result.bodies) addon.Cad.spawnBody(session, body.id, { id, pipelineId, bindings });
const hit = Entropy.Cad.pick(session, rayOrigin, rayDirection);   // { body, feature, part, point, normal }
```

Geometry stays on the Rust side: `spawnBody`, `spawnRegions` and `spawnLines` queue engine meshes
directly, as `MeshCache.createMesh` does. Only summaries, flattened sketch curves (for the app's
own use) and pick results cross into JavaScript. Bodies arrive in the `mesh` vertex layout with
the face index in `uv.x`, so a shader can light one face. Lines arrive as ribbons a shader widens
on screen (see the layout on `spawnLines`), so they are the same crisp width at any zoom.

Everything is in document units; the app's pipeline scales to the world (`UNIT` in `cad_view.ts`
is 0.01: a 100 mm part is one world unit).

## The shared front end

- **`cad_doc.ts`**: types for the document; helpers that keep it consistent (`addEntity`,
  `mergePoints`, `removePoint`, `removeFeature` with its dependents, `moveFeature` that will not
  put a feature ahead of what it reads); and `History`, snapshot undo where a whole gesture is
  one step. No engine calls, so it runs under vitest.
- **`cad_shader.ts`**: one surface shader for bodies, grids, region fills and the backdrop, with
  four view modes (`solid`, `holo`, `zebra`, `curvature`), and the line ribbon shader.
- **`cad_view.ts`**: `CadView` owns the session and everything drawn in 3D. `evaluate(doc)`
  re-spawns only bodies whose `key` changed; `drawSketches(draws, overlays)` redraws sketches from
  a description of what is active, selected and hovered; plus `pick`, `sketchPoint`, `sketchHit`,
  `frame`, `lookAtSketch`, and the suite's shared-view handover.

An app supplies its interaction, panels and palette. Contour Design is about 1,200 lines on top
of this.

## Where the next apps extend it

| App | Likely additions to the foundation |
|---|---|
| Engineering | A sketch constraint solver (the sketch model already shares points; constraints are an added list), dimensions, fillets and chamfers, shells, patterns, a B-rep layer for exact faces, STEP export. |
| Architecture | Larger units and levels, wall/slab/opening features built from strokes and extrudes, section cuts (the boolean and the region fill shader are there), 2D drawing output. |
| Electronics | A 2D-first view of the same sketch model (layers as sketches), nets over shared points, board outline to body via extrude, component bodies. |

Not built yet, and known: no constraint solver; no fillets; booleans are mesh-level, so seams are
exact but faces are not re-parameterised; a stroke around a very tight curve can overlap itself;
no Rhai/web binding for `Entropy.Cad` (the kernel itself compiles for the web).
