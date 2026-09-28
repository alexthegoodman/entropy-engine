## Mesha — bird’s-eye overview

**As a 3D creator, I want to open Mesha, find or describe almost any ordinary object, choose a highly configurable procedural version of it from a library, adjust it visually using meaningful controls, combine it with other objects, and export the resulting geometry—without needing to understand procedural modeling, Geometry Nodes, or traditional mesh construction.**

The experience begins at the **Project** level. I create or open a project and arrive in a familiar 3D viewport with an outliner, properties panel, asset/object browser, transform tools, camera controls, undo/redo, materials, lighting, and the usual basic machinery expected from a 3D application.

But Mesha's fundamental unit isn't really the mesh.

It's the **procedural object**.

### Finding an object

I press **Add Object**.

Instead of primarily seeing Cube, Sphere, Cylinder, etc., I see Mesha's procedural library:

> Furniture → Chair  
> Furniture → Table  
> Architecture → Window  
> Architecture → Door  
> Nature → Tree  
> Nature → Rock  
> Mechanical → Gear  
> Mechanical → Bolt  
> Household → Bottle  
> Electronics → Keyboard  
> …

I can browse categories, search for something by name, or visually browse thumbnails.

I search **“office chair.”**

Several procedural objects appear. I select one and it immediately appears in the viewport.

The object isn't merely an office-chair mesh. It's a **live procedural program representing the design space of an office chair**.

---

## Editing an object

Selecting the chair gives me a simple properties interface.

At the top are its most useful parameters:

> Height  
> Width  
> Seat depth  
> Back height  
> Back curvature  
> Armrests ☑  
> Headrest ☐  
> Wheels: 5  
> Cushion thickness  
> Frame thickness  
> Style  
> Material  
> Wear  
> Seed ↻

Dragging a slider updates the viewport interactively.

Below those controls are expandable sections:

**Seat · Back · Arms · Base · Wheels · Upholstery · Materials · Imperfections · Advanced**

Parameters can depend upon one another. Disabling armrests hides irrelevant armrest controls. Selecting a four-legged base replaces the wheel controls with leg controls.

Everything remains procedural.

---

## Exploring rather than designing

I don't necessarily know exactly what chair I want.

So I hit **Variation**.

Mesha produces another sensible chair.

Again.

Again.

I like this one.

Rather than blindly randomizing every parameter, variation understands parameter metadata and constraints. A bolt doesn't suddenly become 14 meters long. Chair legs don't randomly detach from the seat.

I can also lock properties:

> 🔒 Overall dimensions  
> 🔒 Upholstery  
> Variation ↻

Now Mesha explores everything except those properties.

I can adjust the **variation amount**, from tiny differences to radically different configurations.

I can save any result as a preset.

---

# Agent visual verification

The process for creating Mesha library procedural objects should involve:

- First, building the geometry nodes inspired component catalog
- Then, build out the initial JSON representation
- View it live in the viewer, as well as variations of it to verify correctness
- Depending on correctness and quality, repeat as often as needed until satisfied

---

# Parameter testing

But a good default doesn't prove that a procedural generator works.

So Mesha automatically starts **parameter fuzzing**.

It generates dozens or hundreds of strategically chosen configurations:

```text
Body width = minimum
Body width = maximum
Hopper height = minimum
Hopper height = maximum
Drawer width = maximum
Crank length = minimum
Crank length = maximum
...
```

It also tests combinations and randomized configurations.

Mesha can perform cheap deterministic checks automatically:

> NaNs / invalid geometry  
> Empty geometry  
> Degenerate faces  
> Non-manifold geometry where inappropriate  
> Unexpected disconnected components  
> Extreme bounding boxes  
> Parameter constraint violations  
> Performance limits  
> Material errors

Then it renders selected configurations into **contact sheets**.

The agent visually examines those.

This matters because a technically valid mesh can still be completely ridiculous.

It might discover that the grinder looks good for the default settings but setting `hopper_width=0.8` and `body_width=0.3` creates something physically nonsensical.

So it adds a relationship between those parameters.

Test again.

Render again.

Inspect again.

---

# Acceptance

Eventually report something like:

> **Coffee Grinder — Ready**
>
> 184 parameters  
> 12 parameter groups  
> 27 constraints  
> 8 materials  
> 146 configurations tested  
> 24 configurations visually inspected  
> Geometry tests passed  
> Visual verification passed  
> Average evaluation: 18 ms

---

# Composition

Procedural objects can contain other procedural objects.

A table might reference a reusable **Leg** generator.

A cabinet might contain **Handle**, **Hinge** and **Fastener** generators.

A building might contain procedural windows, doors, stairs, railings, gutters and roofing.

That eventually allows users to construct increasingly sophisticated scenes while retaining semantic editability.

Changing:

> Window count: 4 → 6

doesn't mean rebuilding a wall manually.

The procedural relationship handles it.

---

# Materials

Procedural definitions can expose materials semantically too.

Instead of merely assigning `Material.003`, a chair knows about:

> Frame  
> Upholstery  
> Stitching  
> Feet  
> Fasteners

A generator can ship with procedural materials and material parameters.

Changing the chair's dimensions doesn't destroy material assignments because materials attach to **semantic geometry regions**, not arbitrary face indices wherever possible.

---

# Export

Eventually I select objects—or the entire scene—and export:

> GLTF / GLB  

Mesha evaluates the procedural graph and produces ordinary geometry appropriate for another application or engine.

Export options can control triangulation, mesh density, LOD, material baking, texture resolution, transforms and instancing.

---

# The whole product loop

From 30,000 feet, I'd want Mesha to feel like this:

**Discover → Configure → Vary → Compose → Refine → Export**

### Current viewport controls

The selected object has translation arrows and rotation rings, without scale handles. Right-drag
orbits, middle-drag pans, the wheel zooms, and F frames the selection. Full rotation persists through
save/load, duplication, undo/redo and GLB export. The Placement Turn control sets an upright yaw.
Object geometry stays resident during transforms; picking geometry and contact shadows refresh
at the end of a drag. Procedural parameter changes still rebuild the affected object.
