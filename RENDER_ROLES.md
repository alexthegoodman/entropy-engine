The mental model to anchor on

Pipelines don’t render things. Pipelines render roles.
Instead of asking:
“Which pipeline should render this?”
You ask:
“What role is this thing playing in the composition?”
That lets you keep freedom and clarity.

Introduce a first-class concept: Render Roles

A Render Role is a semantic contract between content and pipelines.

Examples:
Surface
Light
Volume
Background
UI
PostEffect
Simulation
Auxiliary (normals, depth, motion vectors, etc.)

Each pipeline declares:
Which roles it can render
Which role it prefers to render
What outputs it produces

Each asset / layer / entity declares:
Which role(s) it is
Optional overrides