// unused addons
// import "./water_plane_addon";

// initialize first (tier 0)
// import "./standalone/daw_synth_addon";

// tier 1
import "./games/enviornment/environment_addon";
// import "./volumetric_addon";
// import "./volume_dust_addon"; // non-working
import "./games/enviornment/composite_dust_addon"; // dust works
import "./games/enviornment/volumetric_fx_addon"; // fog works, dust doesnt

// import "./standalone/light_hive_addon";
import "./games/level_editor_3d/pbr_texture_designer_addon";

// // tier 2
// import "./flexnoise_terrain_addon";
import "./games/level_editor_3d/flexnoise_v2";
import "./games/level_editor_3d/megaworlds_terrain_addon";
import "./games/level_editor_3d/hair_particle_addon";
// import "./standalone/fft_water_addon";
// okay, but the automatic flow accumlation is bad
// import "./fft_river_addon"; 
// better for flow simulation than for water properties like surface waves and refractions
// import "./gpgpu_river_addon"; 
import "./games/level_editor_3d/model_viewer_addon";
import "./games/level_editor_3d/character_creator_addon";
// import "./basic_character_addon";
// import "./basic_character_addon_gl";
import "./games/level_editor_3d/game_scripts_addon";
import "./games/level_editor_3d/inorganic_modelling_addon";
import "./games/level_editor_3d/procedural_houses_addon";
import "./games/level_editor_3d/behavior_nodes_addon";
import "./games/level_editor_3d/alpha_preview_addon";
// import "./legacy_yumon_addon";

// game logic tier
// import "./horde_mode_game";
// import "./wave_spawner_game";
import "./games/fps_rpg";
// import "./conquest";

// initialize last (tier 3)
import "./games/level_editor_3d/game_composer_addon";

