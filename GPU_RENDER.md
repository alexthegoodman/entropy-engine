# Alpha Renderer

We want to build this as a "separate renderer" and will integrate it with the rest of the engine and addons as time goes on.
We can put it in the `alpha` directory, and we can call our implementation Alpha.

## GPU-Driven Rendering

The general setup:
You'd bind your large persistent buffers once (or rarely), then issue a batch of indirect draws against them. The key buffers you'd typically have:

Mesh/geometry buffer — all your vertex and index data in one big allocation, addressed by byte offset
Instance buffer — per-instance data like transform, material ID, mesh descriptor index
Draw arguments buffer — populated by a compute shader, contains DrawIndexedIndirect structs with instance counts, index offsets, base vertex etc.
Visibility/culling output buffer — your compute culling pass writes into this, compacting surviving instances and filling the draw args

The rough pipeline:
Your culling compute shader reads the instance buffer, performs frustum/occlusion tests, and writes surviving instances into a compacted output buffer while also writing the draw argument counts. Then you call draw_indexed_indirect or multi_draw_indexed_indirect (already enabled, support confirmed) pointing at that draw args buffer — the GPU just consumes it directly.

## Virtualized Geometry

- Have a `PixelsPerVertex` setting or similar to control the max quality (set to a default of 8)
- Use proper algorithms to seal cracks
- Ensure that low-poly models don't overdraw
- It is likely simpler to store important IDs and tags on vertex data, in order to reference the correct buffer contents in shaders