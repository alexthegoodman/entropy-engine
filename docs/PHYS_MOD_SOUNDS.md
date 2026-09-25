As we move Entropy DAW towards a true physically-based DAW, we want to add the ability to create high quality sounds for use in songs. 
We can create these sounds in phases, just as we have done the phys mod strings and phys mod brass sections in phases.
Defintitely reference the strings and brass sections for guidance on what we are going for. They both sound spectacular.

I’d think of the next section as a small set of interacting physics systems rather than six unrelated features.

| System | First convincing targets | Then it generalizes into |
|---|---|---|
| **Membranes** | kick, tom, snare, timpani | arbitrary stretched surfaces, skin, fabric |
| **Plates/shells** | cymbal, gong, bell | sheet metal, panels, resonant objects |
| **Impact** | sticks/mallets, wood/metal/glass hits | footsteps, collisions, bouncing objects |
| **Friction** | drum brushes, scraping, rubbing | squeaks, dragging, sanding, bowed objects |
| **Fracture** | sticks snapping, glass breaking | cracking, crushing, tearing, destruction |
| **Granular** | sand, gravel, beads | dirt, snow, debris, seeds, particle-filled objects |
| **Water** | droplets, pouring, splashes | streams, sloshing, surf, waves |

The particularly beautiful thing is that **drums and cymbals give you a reason to build several of these primitives anyway**.

A snare isn't merely a membrane oscillator. It's membrane + shell + impact + contact + sympathetic coupling + many little wires colliding against a surface. A cymbal requires impact plus a nonlinear vibrating plate/shell. Brushes introduce friction and many-point contact. So an excellent drum kit can serve as the musically useful proving ground for a much more general physics engine.

### Impact might be the connective tissue

I'd prioritize a genuinely excellent generalized **contact/impact model** surprisingly high.

Instead of having a `DrumStickExciter`, you want something conceptually closer to:

**Object A ↔ contact geometry ↔ Object B**

with velocity, mass, hardness/compliance, contact area, angle, surface properties and perhaps deformation determining how energy enters both objects.

Then a drumstick hitting a membrane is just one case. The same interaction can produce:

wood → glass  
metal → concrete  
rock → rock  
finger → drumhead  
mallet → gong  
droplet → metal plate  
debris → resonating structure

That is extremely leveraged work.

### Friction is similarly universal

You already have some version of this problem if your violin bowing is convincing.

Generalizing it beyond bow/string interaction could unlock **scraping almost anything across anything**.

Imagine selecting two objects, enabling contact, pressing them together and dragging one in the viewport:

> rubber × glass  
> metal × stone  
> wood × steel  
> wet finger × membrane  
> brush × cymbal

Pressure, velocity and surface roughness become playable parameters.

That's simultaneously Foley and synthesis.

### Fracture could be spectacular

Fracture gets especially interesting if it isn't merely a procedural “breaking sound generator.”

Suppose an actual simulated resonating object develops cracks.

Before:

```text
──────────────
```

After impact:

```text
──────╲
       ╲──────
```

Its modal structure changes **because its geometry changed**.

Hit it again. The crack propagates. Resonances shift. Eventually a piece separates and falls, collides with the floor, and both fragments continue resonating independently.

Then “breaking glass” isn't a sound effect.

You create a glass object and **break it**.

That would be an extraordinary demonstration of what PBR-DAW means.

### Granular physics could become an instrument class

This one has enormous musical potential.

Make a container. Fill it with 2,000 simulated objects. Shake it.

Particle parameters become synthesis controls:

**count · size distribution · shape · density · elasticity · friction · container geometry**

Maraca presets become merely one coordinate.

Replace seeds with tiny steel spheres. Make them progressively larger. Change the vessel from wood to glass while it's shaking. Reduce gravity. Make particles sticky. Drop the entire thing.

You get sounds that would be tedious or impossible to construct conventionally but remain intuitively understandable.

### Water is probably the deepest rabbit hole

I'd stage this rather than immediately attempting Navier–Stokes-everything.

A first water system capable of **droplets, bubbles, splashes and resonant containers** could already be extremely impressive.

Then pouring and sloshing.

Then flowing water.

Eventually waves and surf.



And water becomes much more interesting when coupled to everything else.

Rain isn't a “rain generator.” It's thousands of water impacts against geometry.

Rain on a:

**window / car roof / tent / lake / leaves / cymbal / giant membrane**

should naturally sound different because the receiving objects are different physical systems.

Likewise, throwing stones into water combines rigid-body motion, impact, displacement, splash generation and eventually underwater acoustics.

### This suggests a killer Entropy demo

Not another orchestral performance.

Start with an empty scene.

Create a sheet of metal. Hit it. Bend it into a cymbal. Hit it again. Change its material and thickness.

Create a glass vessel. Pour simulated beads into it. Shake it. Replace the beads with water. Tilt the vessel and hear it slosh.

Drop the vessel.

**It shatters.**

Fragments hit the floor, resonate and scatter. Water splashes across the floor. A fragment slides to a stop through physical friction.

And the user never loaded a sample.

That ~60-second sequence would communicate **“physically based DAW”** better than pages of explanation. The impressive violin and brass establish that Entropy can reproduce known instruments; something like this establishes that the underlying idea is much bigger.