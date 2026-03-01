// unused addons
// import "./water_plane_addon";

// initialize first (tier 0)
// import "./daw_synth_addon";

// tier 1
import "./environment_addon";
// import "./volumetric_addon";
// import "./volume_dust_addon"; // non-working
import "./composite_dust_addon"; // dust works
import "./volumetric_fx_addon"; // fog works, dust doesnt

import "./light_hive_addon";
import "./pbr_texture_designer_addon";

// // tier 2
// import "./flexnoise_terrain_addon";
import "./flexnoise_v2";
import "./megaworlds_terrain_addon";
import "./hair_particle_addon";
import "./fft_water_addon";
// okay, but the automatic flow accumlation is bad
// import "./fft_river_addon"; 
// better for flow simulation than for water properties like surface waves and refractions
// import "./gpgpu_river_addon"; 
import "./model_viewer_addon";
import "./character_creator_addon";
// import "./basic_character_addon";
// import "./basic_character_addon_gl";
import "./game_scripts_addon";
import "./inorganic_modelling_addon";
import "./procedural_houses_addon";
import "./behavior_nodes_addon";
import "./alpha_preview_addon";
import "./yumon_addon";

// game logic tier
// import "./horde_mode_game";
// import "./wave_spawner_game";
import "./fps_rpg";
import "./conquest";

// initialize last (tier 3)
import "./game_composer_addon";

