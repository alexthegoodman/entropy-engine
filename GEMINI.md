# Entropy Engine

entropy-engine is going to be essentially a mixture of midpoint-engine (game engine) and stunts-engine (video engine) in a unified codebase. It will use Midpoint's landscape system and Stunts's video system, for example. Other things will need to be reconciled, while some things can be safely ignored. Some things, like Text and Font system, will be pulled from Stunts, while other things like Lighting and GLB Import will be pulled from Midpoint.

I have already taken the liberty of moving many files from the respective repos and into the entropy-engine, so we have a good start. Now we need to pull it together in a an entropy-engine/src/startup.rs file. Take inspiration from the export/pipeline.rs file, even reusing the pipeline.rs if possible. It will need to use Winit.

You will notice there are two files for Transform. This is because they need to be reconciled now that they are in this unified repo.

Ultimately, this engine will power separate editor's used for different purposes, and will even power a chat UI which enables the user to do things via chat similar to MCP but hopefully better.