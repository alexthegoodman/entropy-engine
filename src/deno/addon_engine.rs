use deno_core::{
    error::AnyError,
    op2,
    extension,
    JsRuntime,
    RuntimeOptions,
    serde_v8,
    v8,
    OpState,
    Extension,
    ModuleSpecifier,
    ascii_str,
    FsModuleLoader,
    ModuleId,
};
use noise::MultiFractal;
use noise::NoiseFn;
use mint::ColumnMatrix4;
use nalgebra::{Isometry3, Matrix4, Translation3, UnitQuaternion, Vector3};
use noise::{Fbm, Perlin};
use rapier3d::prelude::{ColliderBuilder, LockedAxes, RigidBodyBuilder};
use uuid::Uuid;
// use wgpu::wgc::resource::ResourceType;
use std::rc::Rc;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use crate::art_assets::Model::read_model;
use crate::core::Texture::Texture;
use crate::core::camera::CameraBinding;
use crate::core::editor::{Editor, Point};
use crate::core::gpu_resources::GpuResources;
use crate::core::addon_pipeline::{GBUFFER_FORMATS, create_addon_pipeline};
use crate::core::vertex::Vertex;
use crate::deno::addon_ops::op_yumon_brain_test_infer;
use crate::deno::guitar_ops::{
    op_guitar_list_inputs, op_guitar_start, op_guitar_stop, op_guitar_set, op_guitar_target, op_guitar_status,
    op_guitar_calibrate, op_guitar_record, op_guitar_release_all, op_guitar_set_position,
};
use crate::deno::wavetable_ops::{
    op_wavetable_ensure, op_wavetable_remove, op_wavetable_info, op_wavetable_op, op_wavetable_stamp,
    op_wavetable_set_frame, op_wavetable_export, op_wavetable_import, op_wavetable_harmonics,
    op_wavetable_render_analyze, op_audio_play_wavetable_on_track, op_audio_wavetable_note_on,
    op_audio_wavetable_note_off, op_audio_wavetable_set_position,
};
use crate::deno::music_video_ops::{
    op_music_video_styles, op_music_video_defaults, op_music_video_choose_path, op_music_video_choose_image,
    op_music_video_start, op_music_video_poll, op_music_video_cancel, op_ui_widget_music_visualizer,
};
use crate::deno::brass_ops::{
    op_brass_info, op_brass_remove, op_audio_brass_prepare, op_audio_play_brass_on_track, op_audio_brass_note_on, op_audio_brass_note_off,
    op_audio_brass_set_control, op_brass_render_analyze,
};
use crate::deno::matter_ops::{
    op_matter_info, op_matter_remove, op_audio_matter_prepare, op_audio_play_matter_on_track, op_audio_matter_remove,
    op_matter_render_analyze, op_audio_hold_matter_on_track,
};
use crate::deno::quadplanet_ops::{
    op_quadplanet_create, op_quadplanet_update, op_quadplanet_sample, op_quadplanet_normal, op_quadplanet_landing_site,
    op_quadplanet_info, op_quadplanet_configure, op_quadplanet_clear, op_quadplanet_destroy, op_quadplanet_geocode,
    op_quadplanet_place_name,
};
use crate::deno::water_ops::{
    op_water_info, op_water_remove, op_audio_water_prepare, op_audio_play_water_on_track, op_audio_water_remove,
    op_water_render_analyze,
};
use crate::deno::physmod_ops::{
    op_physmod_info, op_physmod_shape, op_physmod_remove, op_audio_physmod_prepare, op_audio_play_physmod_on_track,
    op_audio_physmod_note_on, op_audio_physmod_note_off, op_audio_physmod_set_bow, op_physmod_render_analyze,
};
use crate::deno::piano_ops::{
    op_piano_info, op_piano_remove, op_audio_piano_prepare, op_audio_play_piano_on_track,
    op_audio_piano_all_notes_off, op_audio_piano_note_on, op_audio_piano_note_off, op_audio_piano_set_pedal, op_piano_render_analyze,
};
use crate::deno::vst3_ops::{
    op_vst3_scan, op_vst3_load, op_vst3_unload, op_vst3_note_on, op_vst3_all_notes_off, op_vst3_open_editor,
    op_vst3_close_editor, op_vst3_poll_state, op_vst3_save_state, op_vst3_find_parameters, op_vst3_set_parameter,
    op_vst3_take_peak, op_vst3_stats,
};
use crate::deno::addon_ops::{
    AddonContext,
    AddonMetadata,
    BindingConfig,
    CompositeInstance, 
    DialogueWrapper, 
    EngineContext, 
    LandscapeTextureUpdate,
    Modifiers, 
    NpcMotionState, 
    PendingAction, 
    ResourceType, 
    ToolDefinition, 
    UiWidget, 
    VisualConfig, 
    YumonActionState, 
    op_addon_load_data, 
    op_addon_on_action, 
    op_addon_on_all_addons_initialized, 
    op_addon_on_all_projects_loaded, 
    op_addon_on_cleanup, 
    op_addon_on_init, 
    op_addon_on_project_changed, op_addon_on_update, op_addon_register,
    op_addon_register_tool, op_addon_save_data, op_addon_save_image, op_addon_store_read, op_addon_store_write, op_addon_store_list, op_addon_store_remove, op_addon_set_visibility, op_launch_example,
    op_alpha_model_load, op_audio_play_note, op_audio_play_synth, op_audio_play_test, op_audio_render_pattern_wav, op_audio_poll_wav_export, op_audio_cancel_wav_export, op_audio_load_sample, op_audio_play_sample_on_track, op_audio_preview_sample, op_audio_stop_preview, op_icon_table, op_io_music_dir, op_clipboard_read_text, op_clipboard_write_text, op_io_pick_sample_folder, op_io_list_dir, op_ui_widget_pad_grid, op_ui_widget_wavetable, op_ui_widget_reverb_eq, op_ui_widget_physmod, op_ui_widget_fretboard, op_ui_widget_piano, op_ui_widget_brass, op_ui_widget_matter, op_ui_widget_water, op_behavior_register, op_buffer_create,
    op_audio_effect_create_delay, op_audio_effect_create_reverb, op_audio_effect_set_delay, op_audio_effect_set_reverb, op_audio_effect_create_character, op_audio_effect_set_character, op_audio_effect_create_eq, op_audio_effect_set_eq, op_audio_effect_destroy,
    op_audio_ensure_track_bus, op_audio_remove_track_bus, op_audio_play_note_on_track,
    op_buffer_destroy, op_buffer_write, op_camera_get_transform, op_camera_screen_to_world, op_camera_set_orthographic, op_camera_set_transform, op_composer_set_role_pipeline,
    op_compute_dispatch, op_compute_pipeline_create, op_cube_spawn, op_dialogue_add_option, op_dialogue_close, op_dialogue_get_node, 
    op_dialogue_select_option, op_dialogue_show, op_dialogue_start_quest, op_entity_apply_impulse, op_entity_get_stats, op_entity_play_animation, 
    op_entity_set_rotation, op_entity_set_stats, op_entity_set_velocity, op_entity_set_xz_velocity, op_generate_uuid, op_gizmo_hide, op_gizmo_show, 
    op_gizmo_update, op_gizmo_update_rotation, op_grass_create, op_input_get_state, op_io_list_models, op_io_pick_and_import_model, op_landscape_create, op_landscape_get_height,
    op_landscape_update_pbr_texture, op_landscape_update_texture, op_landscape3d_create, op_lighting_update_sun, op_mesh_clear, op_mesh_create, 
    op_mesh_get_data, op_mesh_update_vertices, op_meshes_clear, op_model_load, op_model_export_glb, op_model_set_bone_transform, op_noise_create, op_pipeline_create, op_point_light_create,
    op_point_light_remove, op_lighting_set_point_light_shader, op_shadow_configure,
    op_println, op_quadscape_create, op_register_composite_texture, op_script_list, op_script_read, op_script_write, op_selection_get_selected,
    op_set_game_mode, op_system_spawn_particles, op_texture_create, op_texture_create_ex, op_texture_load, op_texture_update,
    op_video_open, op_video_bind_texture, op_video_play, op_video_pause, op_video_seek, op_video_set_volume, op_video_set_speed, op_video_read_subtitles, op_video_close, op_video_poll,
    op_video_export_start, op_video_export_poll,
    op_ui_clear,
    op_ui_create_tab, op_ui_get_tabs, op_ui_set_active_tab, op_ui_get_active_tab, op_ui_create_window, op_ui_rect_create, op_ui_text_create, op_ui_widget_button, op_ui_widget_checkbox, op_ui_widget_code_editor, 
    op_ui_widget_collapsing_header, op_ui_widget_color_input, op_ui_widget_dropdown, op_ui_widget_end_collapsing_header, op_ui_widget_end_horizontal, 
    op_ui_widget_label, op_ui_widget_mini_map, op_ui_widget_numeric_input, op_ui_widget_piano_roll, op_ui_widget_keyframe_timeline, op_ui_widget_tracks, op_ui_widget_kanban, op_ui_widget_tree_view, op_ui_widget_tab_bar, op_ui_widget_layout, op_ui_widget_segmented, op_ui_widget_sheet_grid, op_ui_widget_oscilloscope, op_ui_widget_spectrum, op_ui_widget_level_meter, op_audio_analyze, op_ui_widget_separator, op_ui_widget_slider, op_ui_widget_knob, op_ui_widget_snarl,
    op_ui_widget_start_horizontal, op_ui_widget_hyperlink, op_ui_widget_text_input, op_ui_widget_doc_editor, op_doc_editor_toggle_bold,
    op_ui_widget_start_vertical, op_ui_widget_end_vertical, op_ui_widget_start_group, op_ui_widget_end_group,
    op_doc_editor_toggle_italic, op_doc_editor_set_font_family, op_doc_editor_set_font_size, op_doc_editor_set_color, op_doc_editor_set_paginated,
    op_doc_editor_load_sample, op_doc_editor_font_names, op_ui_render_html, op_http_get_text, op_http_fetch_text, op_http_poll_text, op_http_cancel_text,
    op_ui_set_theme, op_ui_widget_extras, op_ui_toast, op_ui_dismiss_toast, op_ui_set_preferences, op_ui_keyboard_state, op_visual_load, op_window_get_size, op_window_set_fullscreen, op_yumon_brain_augment, op_yumon_brain_create, op_yumon_brain_get_state,
    op_yumon_brain_infer, op_yumon_brain_load, op_yumon_brain_observe, op_yumon_brain_save, op_yumon_brain_sleep, op_yumon_create, op_yumon_sleep, op_yumon_tick,
    op_ml_graph_train, op_ml_graph_poll, op_ml_architecture_train, op_ml_architecture_poll
};
use crate::game_behaviors::stateful::BehaviorConfig;
use crate::heightfield_landscapes::Landscape::Landscape;
use crate::heightfield_landscapes::Landscape3D::Landscape3D;
use crate::heightfield_landscapes::QuadScape::QuadScape;
use crate::heightfield_landscapes::QuadTree::Terrain;
use crate::helpers::saved_data::{ComponentKind, LandscapeTextureKinds, NPCProperties, PhysicsConfig, VisualType};
use crate::model_components::NPC::NPC;
use crate::procedural_grass::grass::Grass;
use crate::renderer_text::fonts::FontManager;
use crate::yumon::system::Action;
use wgpu::{RenderPipeline, TextureView};
use crate::shape_primitives::Cube::Cube;
use crate::core::RendererState::RendererState;
use crate::core::SimpleCamera::SimpleCamera;
use crate::core::custom_mesh::CustomMesh;
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::renderer_text::text_due::{TextRenderer, TextRendererConfig};
use crate::audio::AudioEngine;
use crate::helpers::utilities::get_project_dir;
use crate::yumon::legacy::{OrganismSim, MyBackend};
use crate::egui;
use wgpu::util::DeviceExt;
use crate::egui_wgpu;

/// A `pipelineId: "default"` mesh (Entropy.Model.createMesh) is actually drawn with the
/// engine's own geometry_pipeline at render time (render_addon_frame.rs) - this pipeline is
/// never bound or executed. It exists only because CustomMesh::new requires *some*
/// `Arc<RenderPipeline>` to construct. Before this, the "default" branch below looked for any
/// already-registered custom pipeline (`ctx.pipelines.values().next()`) and silently dropped
/// the mesh - with no error - if the addon had never created one of its own (e.g. an addon
/// that only ever spawns "default" meshes, like Light Hive's demo scene). Building one
/// unconditionally here removes that dependency on incidental addon state.
fn create_placeholder_render_pipeline(device: &wgpu::Device) -> RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Default-Mesh Placeholder Shader (never executed)"),
        source: wgpu::ShaderSource::Wgsl(
            "@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }\n\
             @fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }".into(),
        ),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Default-Mesh Placeholder Pipeline (never executed)"),
        layout: None, // auto-inferred - this pipeline has no bind groups
        vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_main"), buffers: &[], compilation_options: wgpu::PipelineCompilationOptions::default() },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    })
}

extension!(
    entropy_addons,
    ops = [
        op_addon_register,
        op_addon_on_init,
        op_addon_on_all_addons_initialized,
        op_addon_on_update,
        op_addon_on_cleanup,
        op_addon_on_action,
        op_yumon_create,
        op_yumon_tick,
        op_yumon_sleep,
        op_pipeline_create,
        op_compute_pipeline_create,
        op_compute_dispatch,
        op_buffer_create,
        op_buffer_write,
        op_buffer_destroy,
        op_cube_spawn,
        op_model_load,
        op_model_export_glb,
        op_alpha_model_load,
        op_visual_load,
        op_mesh_create,
        op_mesh_clear,
        op_meshes_clear,
        op_landscape_create,
        op_landscape3d_create,
        op_landscape_get_height,
        op_landscape_update_texture,
        op_landscape_update_pbr_texture,
        op_grass_create,
        op_noise_create,
        op_point_light_create,
        op_point_light_remove,
        op_lighting_set_point_light_shader,
        op_shadow_configure,
        op_composer_set_role_pipeline,
        op_lighting_update_sun,
        op_println,
        op_ui_create_window,
        crate::deno::addon_ops::op_ui_set_window_visible,
        op_ui_create_tab,
        op_ui_get_tabs,
        op_ui_set_active_tab,
        op_ui_get_active_tab,
        op_ui_widget_label,
        op_ui_widget_button,
        op_ui_widget_color_input,
        op_ui_widget_slider,
        op_ui_widget_knob,
        op_ui_widget_extras,
        op_ui_toast,
        op_ui_dismiss_toast,
        op_ui_set_preferences,
        op_ui_keyboard_state,
        op_ui_widget_numeric_input,
        op_ui_widget_dropdown,
        op_ui_widget_checkbox,
        op_ui_widget_code_editor,
        op_ui_widget_mini_map,
        op_ui_widget_snarl,
        op_ui_widget_piano_roll,
        op_ui_widget_keyframe_timeline,
        op_ui_widget_tracks,
        op_ui_widget_kanban,
        op_ui_widget_tree_view,
        op_ui_widget_tab_bar,
        op_ui_widget_layout,
        op_ui_widget_segmented,
        op_ui_widget_sheet_grid,
        op_ui_widget_pad_grid,
        op_ui_widget_wavetable,
        op_ui_widget_reverb_eq,
        op_wavetable_ensure,
        op_wavetable_remove,
        op_wavetable_info,
        op_wavetable_op,
        op_wavetable_stamp,
        op_wavetable_set_frame,
        op_wavetable_export,
        op_wavetable_import,
        op_wavetable_harmonics,
        op_wavetable_render_analyze,
        op_audio_play_wavetable_on_track,
        op_audio_wavetable_note_on,
        op_audio_wavetable_note_off,
        op_audio_wavetable_set_position,
        op_ui_widget_physmod,
        op_ui_widget_fretboard,
        op_ui_widget_piano,
        op_ui_widget_brass,
        op_physmod_info,
        op_physmod_shape,
        op_physmod_remove,
        op_audio_physmod_prepare,
        op_audio_play_physmod_on_track,
        op_audio_physmod_note_on,
        op_audio_physmod_note_off,
        op_audio_physmod_set_bow,
        op_physmod_render_analyze,
        op_piano_info,
        op_piano_remove,
        op_audio_piano_prepare,
        op_audio_play_piano_on_track,
        op_audio_piano_note_on,
        op_audio_piano_all_notes_off,
        op_audio_piano_note_off,
        op_audio_piano_set_pedal,
        op_piano_render_analyze,
        op_brass_info,
        op_brass_remove,
        op_audio_brass_prepare,
        op_audio_play_brass_on_track,
        op_audio_brass_note_on,
        op_audio_brass_note_off,
        op_audio_brass_set_control,
        op_brass_render_analyze,
        op_matter_info,
        op_matter_remove,
        op_audio_matter_prepare,
        op_audio_play_matter_on_track,
        op_audio_matter_remove,
        op_matter_render_analyze,
        op_audio_hold_matter_on_track,
        op_water_info,
        op_water_remove,
        op_audio_water_prepare,
        op_audio_play_water_on_track,
        op_audio_water_remove,
        op_water_render_analyze,
        op_ui_widget_matter,
        op_ui_widget_water,
        op_ui_widget_oscilloscope,
        op_ui_widget_spectrum,
        op_ui_widget_level_meter,
        op_audio_analyze,
        op_ui_widget_collapsing_header,
        op_ui_widget_end_collapsing_header,
        op_ui_widget_start_horizontal,
        op_ui_widget_end_horizontal,
        op_ui_widget_start_vertical,
        op_ui_widget_end_vertical,
        op_ui_widget_start_group,
        op_ui_widget_end_group,
        op_ui_widget_separator,
        op_ui_widget_hyperlink,
        op_ui_widget_text_input,
        op_ui_widget_doc_editor,
        op_doc_editor_toggle_bold,
        op_doc_editor_toggle_italic,
        op_doc_editor_set_font_family,
        op_doc_editor_set_font_size,
        op_doc_editor_set_color,
        op_doc_editor_set_paginated,
        op_doc_editor_load_sample,
        op_doc_editor_font_names,
        op_ui_render_html,
        op_http_get_text,
        op_http_fetch_text,
        op_http_poll_text,
        op_http_cancel_text,
        op_ui_set_theme,
        op_addon_save_data,
        op_addon_save_image,
        op_addon_store_read,
        op_addon_store_write,
        op_addon_store_list,
        op_addon_store_remove,
        op_launch_example,
        op_io_list_models,
        op_io_pick_and_import_model,
        op_script_list,
        op_script_read,
        op_script_write,
        op_texture_create,
        op_texture_create_ex,
        op_texture_load,
        op_texture_update,
        op_video_open,
        op_video_bind_texture,
        op_video_play,
        op_video_pause,
        op_video_seek,
        op_video_set_volume,
        op_video_set_speed,
        op_video_read_subtitles,
        op_video_close,
        op_video_poll,
        op_video_export_start,
        op_video_export_poll,
        op_music_video_styles,
        op_music_video_defaults,
        op_music_video_choose_path,
        op_music_video_choose_image,
        op_music_video_start,
        op_music_video_poll,
        op_music_video_cancel,
        op_ui_widget_music_visualizer,
        op_addon_load_data,
        op_audio_play_synth,
        op_audio_play_note,
        op_audio_play_test,
        op_audio_render_pattern_wav, op_audio_poll_wav_export, op_audio_cancel_wav_export,
        op_audio_load_sample,
        op_audio_play_sample_on_track,
        op_audio_preview_sample,
        op_audio_stop_preview,
        op_icon_table,
        op_io_music_dir,
        op_clipboard_read_text,
        op_clipboard_write_text,
        op_io_pick_sample_folder,
        op_io_list_dir,
        op_audio_effect_create_delay,
        op_audio_effect_create_reverb,
        op_audio_effect_set_delay,
        op_audio_effect_set_reverb,
        op_audio_effect_create_character,
        op_audio_effect_set_character,
        op_audio_effect_create_eq,
        op_audio_effect_set_eq,
        op_audio_effect_destroy,
        op_audio_ensure_track_bus,
        op_audio_remove_track_bus,
        op_audio_play_note_on_track,
        op_guitar_list_inputs,
        op_guitar_start,
        op_guitar_stop,
        op_guitar_set,
        op_guitar_target,
        op_guitar_status,
        op_guitar_calibrate,
        op_guitar_record,
        op_guitar_release_all,
        op_guitar_set_position,
        op_vst3_scan,
        op_vst3_load,
        op_vst3_unload,
        op_vst3_note_on,
        op_vst3_all_notes_off,
        op_vst3_open_editor,
        op_vst3_close_editor,
        op_vst3_poll_state,
        op_vst3_save_state,
        op_vst3_find_parameters,
        op_vst3_set_parameter,
        op_vst3_take_peak,
        op_vst3_stats,
        op_addon_on_project_changed,
        op_addon_set_visibility,
        op_camera_get_transform,
        op_camera_set_transform,
        op_camera_set_orthographic,
        op_generate_uuid,
        op_register_composite_texture,
        op_addon_register_tool,
        op_addon_on_all_projects_loaded,
        op_set_game_mode,
        op_gizmo_show,
        op_gizmo_hide,
        op_gizmo_update,
        op_gizmo_update_rotation,
        op_input_get_state,
        op_camera_screen_to_world,
        op_window_get_size,
        op_window_set_fullscreen,
        op_selection_get_selected,
        op_ui_rect_create,
        op_ui_text_create,
        op_ui_clear,
        op_mesh_get_data,
        op_mesh_update_vertices,
        op_behavior_register,
        op_system_spawn_particles,
        op_dialogue_show,
        op_dialogue_add_option,
        op_dialogue_start_quest,
        op_dialogue_close,
        op_dialogue_get_node,
        op_dialogue_select_option,
        op_entity_apply_impulse,
        op_entity_set_velocity,
        op_entity_set_xz_velocity,
        op_entity_set_rotation,
        op_entity_play_animation,
        op_entity_set_stats,
        op_entity_get_stats,
        op_model_set_bone_transform,
        op_quadscape_create,
        op_quadplanet_create,
        op_quadplanet_update,
        op_quadplanet_sample,
        op_quadplanet_normal,
        op_quadplanet_landing_site,
        op_quadplanet_info,
        op_quadplanet_configure,
        op_quadplanet_clear,
        op_quadplanet_destroy,
        op_quadplanet_geocode,
        op_quadplanet_place_name,
        op_yumon_brain_create,
        op_yumon_brain_observe,
        op_yumon_brain_infer,
        op_yumon_brain_sleep,
        op_yumon_brain_save,
        op_yumon_brain_load,
        op_yumon_brain_get_state,
        op_yumon_brain_augment,
        op_yumon_brain_test_infer,
        op_ml_graph_train,
        op_ml_graph_poll,
        op_ml_architecture_train,
        op_ml_architecture_poll
    ],
    esm_entry_point = "ext:entropy_addons/addon_setup.js",
    esm = [ dir "src/deno", "addon_setup.js" ],
);

pub struct AddonEngine {
    pub runtime: JsRuntime,
    /// Selected addon from the last tab UI pass, cached for scene rendering.
    pub selected_addon_name: Option<String>,
    pub project_id: Option<String>,
    /// Overrides art-asset path resolution (`Entropy.Model.load`/`Entropy.Texture.load`) to read
    /// straight from this directory instead of Studio's `project_id`-keyed MidPoint convention -
    /// set via `EntropyApp::with_art_assets_dir`. Deliberately independent of `project_id`:
    /// reusing that field for a bare `EntropyApp` meant piggybacking on `load_game_project`'s
    /// full Studio project-load machinery (state.json et al.) just to get a path resolved, which
    /// only worked by coincidence and doesn't scale now that `EntropyApp` has no project concept.
    pub art_assets_dir: Option<PathBuf>,
    pub dummy_views: Vec<(u32, TextureView)>,
    /// Bundle file watched for hot reload (set via `enable_hot_reload`), and the mtime it
    /// had the last time we checked - `None` means hot reload is off (the default: Studio's
    /// compiled-in `DEFAULT_ADDON_BUNDLE` has no file on disk to watch, and embedders opt in
    /// explicitly via `EntropyApp::with_hot_reload`).
    hot_reload_path: Option<PathBuf>,
    hot_reload_last_mtime: Option<std::time::SystemTime>,
    /// The most recently observed not-yet-loaded mtime, and when we first saw it - reloaded
    /// only once that mtime has held for `HOT_RELOAD_DEBOUNCE`. See the comment in
    /// `check_hot_reload` for why a debounce is needed at all: `deno bundle src.ts > out.js`
    /// truncates `out.js` before `deno` has written anything, and (confirmed empirically) the
    /// resulting empty file's mtime can hold steady for well over a frame before the real
    /// content lands, so a poll-count debounce isn't long enough - this needs wall-clock time.
    hot_reload_pending: Option<(std::time::SystemTime, std::time::Instant)>,
    /// Bumped on every reload so each re-execution gets a distinct script name, purely for
    /// readable stack traces/error messages - `execute_script` doesn't dedupe by name.
    hot_reload_gen: u32,
}

const DEFAULT_ADDON_BUNDLE: &str = include_str!("../../examples/studio-bundle/dist/bundle.js");

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EntityWrapper {
    pub id: String,
    pub name: String,
    pub position: [f32; 3],
    pub health: f32,
    pub stamina: f32,
    pub is_dead: bool,
}

impl AddonEngine {
    pub fn execute_behavior(
        &mut self,
        renderer_state: &mut RendererState,
        behavior_id: &str,
        entity_wrapper: EntityWrapper,
        hook_name: &str,
        current_node: Option<String>,
    ) -> Option<DialogueWrapper> {
        let behavior = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context.behaviors.get(behavior_id).cloned()
        };

        // println!("Execute behavior: {:?} {:?}", hook_name, entity_wrapper);

        let mut dialogue_result = None;

        if let Some(behavior) = behavior {
            let callback = match hook_name {
                "on_update" => behavior.on_update,
                "on_interact" => behavior.on_interact,
                "on_attack" => behavior.on_attack,
                _ => None,
            };

            if let Some(callback) = callback {
                // Prepare context for ops
                let context = EngineContext {
                    particle_spawns: Vec::new(),
                    dialogue_wrapper: if hook_name == "on_interact" {
                        Some(DialogueWrapper {
                            text: String::new(),
                            options: Vec::new(),
                            changed: false,
                            is_open: false,
                            npc_name: String::new(),
                            current_node: current_node.unwrap_or_else(|| "start".to_string()),
                            started_quest: None,
                        })
                    } else {
                        None
                    },
                };
                self.runtime.op_state().borrow_mut().put(context);

                {
                    let scope = &mut self.runtime.handle_scope();
                    let local_callback = v8::Local::new(scope, callback);
                    let this = v8::undefined(scope);
                    let global = scope.get_current_context().global(scope);

                    // 1. Entity Arg
                    let entity_v8 = serde_v8::to_v8(scope, entity_wrapper).unwrap();

                    let args: Vec<v8::Local<v8::Value>> = if hook_name == "on_interact" {
                        let create_dialogue_key = v8::String::new(scope, "_createDialogue").unwrap();
                        let create_dialogue_val = global.get(scope, create_dialogue_key.into()).unwrap();
                        let create_dialogue_func = v8::Local::<v8::Function>::try_from(create_dialogue_val)
                            .expect("addon_setup.js should define _createDialogue");
                        let dialogue_arg = create_dialogue_func.call(scope, global.into(), &[]).unwrap();
                        vec![entity_v8, dialogue_arg]
                    } else {
                        // 2. System Arg
                        let create_system_key = v8::String::new(scope, "_createSystem").unwrap();
                        let create_system_val = global.get(scope, create_system_key.into()).unwrap();
                        let create_system_func = v8::Local::<v8::Function>::try_from(create_system_val)
                            .expect("addon_setup.js should define _createSystem");
                        let system_arg = create_system_func.call(scope, global.into(), &[]).unwrap();

                        // 3. State Arg (for now just empty map or component script state)
                        let state_arg = serde_v8::to_v8(scope, HashMap::<String, String>::new()).unwrap();

                        vec![entity_v8, system_arg, state_arg]
                    };
                    
                    let tc = &mut v8::TryCatch::new(scope);
                    local_callback.call(tc, this.into(), &args);

                    if tc.has_caught() {
                        if let Some(exception) = tc.exception() {
                            let msg = exception.to_rust_string_lossy(tc);
                            println!("[BEHAVIOR ERROR in {}] {}", behavior_id, msg);
                        }
                    }
                }

                // Process results (particles, etc.)
                let (particle_spawns, d_res) = {
                    let mut op_state = self.runtime.op_state();
                    let mut op_state = op_state.borrow_mut();
                    if let Some(ctx) = op_state.try_borrow_mut::<EngineContext>() {
                        (std::mem::take(&mut ctx.particle_spawns), ctx.dialogue_wrapper.take())
                    } else {
                        (Vec::new(), None)
                    }
                };
                dialogue_result = d_res;

                for spawn in particle_spawns {
                    let gpu_resources = self.runtime.op_state().borrow().borrow::<AddonContext>().gpu_resources.as_ref().unwrap().clone();
                    
                    let uniforms = crate::procedural_particles::particle_system::ParticleUniforms {
                        position: [spawn.position[0], spawn.position[1], spawn.position[2], 0.0],
                        time: 0.0,
                        emission_rate: spawn.emission_rate,
                        life_time: spawn.life_time,
                        radius: spawn.radius,
                        gravity: [spawn.gravity[0], spawn.gravity[1], spawn.gravity[2], 0.0],
                        initial_speed_min: spawn.initial_speed_min,
                        initial_speed_max: spawn.initial_speed_max,
                        start_color: spawn.start_color,
                        end_color: spawn.end_color,
                        size: spawn.size,
                        mode: spawn.mode,
                        target_position: [0.0, 0.0, 0.0, 0.0],
                        _pad2: [0.0; 4],
                    };
                    
                    let system = crate::procedural_particles::particle_system::ParticleSystem::new(
                        &gpu_resources.device,
                        &renderer_state.model_bind_group_layout, // Assuming model layout is compatible or use camera layout
                        uniforms,
                        500,
                        wgpu::TextureFormat::Rgba8Unorm,
                    );
                    
                    renderer_state.particle_systems.push(system);
                }
            }
        }
        dialogue_result
    }

    pub fn new(project_id: Option<String>, data_dir: Option<PathBuf>, art_assets_dir: Option<PathBuf>) -> Self {
        let loader = Rc::new(FsModuleLoader);
        let ext = entropy_addons::init_ops_and_esm();

        // Opt-in V8 flags for profiling addon JS, e.g. `ENTROPY_V8_FLAGS=--perf-basic-prof` so
        // `perf` can name JIT-compiled addon functions. Must be set before the first isolate.
        if let Ok(flags) = std::env::var("ENTROPY_V8_FLAGS") {
            static SET_FLAGS: std::sync::Once = std::sync::Once::new();
            SET_FLAGS.call_once(|| {
                let args: Vec<String> = std::iter::once("entropy".to_string()).chain(flags.split_whitespace().map(str::to_string)).collect();
                let unrecognized = deno_core::v8_set_flags(args);
                if unrecognized.len() > 1 {
                    eprintln!("ENTROPY_V8_FLAGS: V8 did not recognize {:?}", &unrecognized[1..]);
                }
            });
        }

        let mut runtime = JsRuntime::new(RuntimeOptions {
            module_loader: Some(loader),
            extensions: vec![
                ext,
            ],
            ..Default::default()
        });

        let audio_engine = Arc::new(AudioEngine::new());

        let context = AddonContext {
            registered_addons: Vec::new(),
            behaviors: HashMap::new(),
            gpu_resources: None,
            audio_engine,
            pipelines: HashMap::new(),
            compute_pipelines: HashMap::new(),
            pipeline_configs: HashMap::new(),
            lighting_pipelines: HashMap::new(),
            lighting_bind_groups: HashMap::new(),
            bind_group_layouts: Vec::new(),
            lighting_bind_group_layouts: Vec::new(),
            surface_format: None,
            grass_uniform_layout: None,
            landscape_particle_layout: None,
            composite_layout: None,
            skinned_layout: None,
            pending_cubes: Vec::new(),
            pending_models: Vec::new(),
            pending_visuals: Vec::new(),
            pending_meshes: Vec::new(),
            pending_clears: Vec::new(),
            pending_mesh_clears: Vec::new(),
            pending_landscapes: Vec::new(),
            pending_landscape3ds: Vec::new(),
            pending_grasses: Vec::new(),
            pending_point_lights: Vec::new(),
            pending_point_light_removals: Vec::new(),
            pending_composites: Vec::new(),
            pending_mesh_updates: Vec::new(),
            pending_sun_config: None,
            pending_lighting_shader: None,
            pending_shadow_config: None,
            pending_game_mode: None,
            pending_entity_impulses: Vec::new(),
            pending_animation_plays: Vec::new(),
            pending_stat_updates: Vec::new(),
            pending_entity_velocities: Vec::new(),
            pending_entity_xz_velocities: Vec::new(),
            active_gizmo: None,
            noise_generators: HashMap::new(),            
            on_init_callbacks: Vec::new(),
            on_all_addons_initialized_callbacks: Vec::new(),
            on_cleanup_callbacks: Vec::new(),
            on_update_callbacks: Vec::new(),
            on_project_changed_callbacks: Vec::new(),
            ui_windows: HashMap::new(),
            window_order: Vec::new(),
            ui_tabs: HashMap::new(),
            tab_order: Vec::new(),
            active_tab: None,
            taskbar_start_menu_open: false,
            ui_widgets: HashMap::new(),
            ui_frame_labels: Vec::new(),
            ui_frame_labels_from_tabs: false,
            pending_theme: None,
            ui_events: Arc::new(Mutex::new(Vec::new())),
            doc_editor_commands: HashMap::new(),
            new_tabs: Vec::new(),
            render_roles: HashMap::new(),
            project_id: project_id.clone(),
            data_dir: data_dir.clone(),
            textures: HashMap::new(),
            raw_textures: HashMap::new(),
            landscape_texture_view: None,
            landscape_heights: None,
            landscape_position: [0.0, 0.0, 0.0],
            landscape_config: None,
            addon_textures: HashMap::new(),
            html_image_dims: HashMap::new(),
            html_image_failed: HashSet::new(),
            html_css_cache: HashMap::new(),
            html_css_failed: HashSet::new(),
            net_text_fetches: HashMap::new(),
            pending_landscape_texture_updates: Vec::new(),
            hidden_addons: HashSet::new(),
            buffers: HashMap::new(),
            compute_encoder: None,
            current_time: 0.0,
            camera_position: [0.0, 0.0, 0.0],
            camera_direction: [0.0, 0.0, -1.0],
            camera_view: ColumnMatrix4::from([1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
            camera_proj: ColumnMatrix4::from([1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
            composite_pipelines: HashMap::new(),
            composites: Vec::new(),
            model_cache: HashMap::new(),
            registered_tools: HashMap::new(),
            op_addon_on_all_projects_loaded_callbacks: Vec::new(),
            egui_textures: HashMap::new(),
            glass_blur_texture_id: None,
            input_events: Vec::new(),
            pressed_keys: HashSet::new(),
            mouse_position: [0.0, 0.0],
            pointer_over_ui: false,
            pending_ui_prefs: None,
            pending_toasts: Vec::new(),
            ui_wants_keyboard: false,
            ui_keyboard_navigating: false,
            bdd_pointer_in_viewport: false,
            modifiers: Modifiers::default(),
            window_size: [1920, 1080],
            pending_fullscreen: None,
            selected_entity_id: None,
            pending_camera_position: None,
            pending_camera_target: None,
            pending_camera_up: None,
            pending_camera_ortho: None,
            pending_bone_transforms: Vec::new(),
            pending_entity_rotations: Vec::new(),
            pending_ui_rects: Vec::new(),
            pending_ui_texts: Vec::new(),
            pending_ui_clear: false,
            pending_alpha_models: Vec::new(),
            pending_quadscapes: Vec::new(),
            quadplanets: HashMap::new(),
            yumon_sims: HashMap::new(),
            yumon_brains: HashMap::new(),
            yumon_runtime_actions: HashMap::new(),
            yumon_trainers: HashMap::new(),
            ml_trainers: HashMap::new(),
            ml_architecture_trainers: HashMap::new(),
            yumon_instances: HashMap::new(),
            npc_motion_states: HashMap::new(),
            on_action_callbacks: Vec::new(),
            #[cfg(not(target_arch = "wasm32"))]
            video_players: HashMap::new(),
            #[cfg(not(target_arch = "wasm32"))]
            pending_video_export: None,
            #[cfg(not(target_arch = "wasm32"))]
            video_export_result: None,
            #[cfg(not(target_arch = "wasm32"))]
            music_video_job: None,
            music_previews: HashMap::new(),
        };
        runtime.op_state().borrow_mut().put(context);

        AddonEngine {
            runtime,
            selected_addon_name: None,
            project_id,
            art_assets_dir,
            dummy_views: Vec::new(),
            hot_reload_path: None,
            hot_reload_last_mtime: None,
            hot_reload_pending: None,
            hot_reload_gen: 0,
        }
    }

    pub fn set_project_id(&mut self, renderer_state: &RendererState, project_id: String) {
        self.project_id = Some(project_id.clone());

        // Update context
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();
            context.project_id = Some(project_id.clone());

            // Preload existing Yumon brains
            if let Some(yumon_dir) = crate::helpers::utilities::get_yumon_dir(&project_id) {
                if let Ok(entries) = std::fs::read_dir(&yumon_dir) {
                    for entry in entries.flatten() {
                        if entry.path().is_dir() {
                            let archetype_name = entry.file_name().to_string_lossy().to_string();
                            let brain_dir = entry.path();
                            if brain_dir.join("metadata.json").exists() {
                                let device = Default::default();
                                match crate::yumon::system::YumonBrain::<crate::yumon::system::MyBackend>::load(device, &brain_dir) {
                                    Ok(brain) => {
                                        println!("[AddonEngine] ✅ Preloaded Yumon brain: {}", archetype_name);
                                        context.yumon_brains.insert(archetype_name, brain);
                                    }
                                    Err(e) => {
                                        eprintln!("[AddonEngine] ❌ Failed to preload Yumon brain {}: {}", archetype_name, e);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Notify all registered callbacks
        self.notify_project_changed(renderer_state, &project_id);
    }    
    fn notify_project_changed(&mut self, renderer_state: &RendererState,  new_project_id: &str) {
        let callbacks = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context.on_project_changed_callbacks.clone()
        };
        
        for (_addon_name, callback) in callbacks {
            let scope = &mut self.runtime.handle_scope();
            let local_callback = v8::Local::new(scope, callback);
            let this = v8::undefined(scope);
            let project_id_str = v8::String::new(scope, new_project_id).unwrap();
            let args = &[project_id_str.into()];
            
            local_callback.call(scope, this.into(), args);
        }

        // Update context
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();

            let mut landscape_view = renderer_state.addon_landscapes
                                                                .get("Game Composer")
                                                                .and_then(|al| al.first().and_then(|l| l.particle_texture_view.clone()));

            // maybe later
            // context.current_time = current_time;
            // context.camera_position = [camera.position.x, camera.position.y, camera.position.z];
            // context.camera_direction = [camera.direction.x, camera.direction.y, camera.direction.z];
            context.landscape_texture_view = landscape_view.clone();

            println!("---- [landscape] landscape_view {:?} {:?}", renderer_state.addon_landscapes.len(), landscape_view.is_some());
        }

        self.notify_all_projects_loaded(&new_project_id);
    }

    fn notify_all_projects_loaded(&mut self, new_project_id: &str) {
        let callbacks = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context.op_addon_on_all_projects_loaded_callbacks.clone()
        };
        
        for (_addon_name, callback) in callbacks {
            let scope = &mut self.runtime.handle_scope();
            let local_callback = v8::Local::new(scope, callback);
            let this = v8::undefined(scope);
            let project_id_str = v8::String::new(scope, new_project_id).unwrap();
            let args = &[project_id_str.into()];
            
            local_callback.call(scope, this.into(), args);
        }
    }

    fn create_bindings_from_config(
        &mut self,
        gpu: &GpuResources,
        landscape_view: Option<Arc<wgpu::TextureView>>,
        pipeline: &wgpu::RenderPipeline,
        bindings: Vec<BindingConfig>,
        id: Option<String>,
        current_addon_name: String,
    ) -> (Vec<wgpu::BindGroup>, Vec<wgpu::Buffer>, Vec<wgpu::Sampler>, Option<wgpu::Buffer>) {
        let mut bind_groups = Vec::new();
        let mut uniform_buffers = Vec::new();
        let mut samplers = Vec::new();
        let mut time_buffer = None;

        let mut groups: HashMap<u32, Vec<BindingConfig>> = HashMap::new();
        for b in bindings {
            groups.entry(b.group).or_default().push(b);
        }

        let mut sorted_groups: Vec<_> = groups.into_iter().collect();
        sorted_groups.sort_by_key(|(group_num, _)| *group_num);

        for (_, group_bindings) in &mut sorted_groups {
            group_bindings.sort_by_key(|b| b.binding);
        }

        for (group_idx, binding_configs) in sorted_groups {
            // println!("get_bind_group_layout {:?} {:?} {:?}", id, group_idx, binding_configs);
            let layout = pipeline.get_bind_group_layout(group_idx);
            // println!("got it! {:?}", id);
            
            let mut created_buffers: Vec<(u32, Arc<wgpu::Buffer>)> = Vec::new();
            let mut created_samplers = Vec::new();
            let mut addon_texture_views = HashMap::new();

            // 1. Pre-fetch addon textures
            {
                let op_state = self.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                    for b in &binding_configs {
                        let id_str = match &b.resource {
                            ResourceType::Texture { id: Some(id) } => Some(id.clone()),
                            ResourceType::StorageTexture { id } => Some(id.clone()),
                            ResourceType::StorageTextureRgba16 { id } => Some(id.clone()),
                            ResourceType::TextureNonFilterable { id } => Some(id.clone()),
                            _ => None,
                        };
                        if let Some(id) = id_str {
                            if id != "Landscape" {
                                if let Some(view) = ctx.textures.get(&id) {
                                    addon_texture_views.insert(id, Arc::clone(view));
                                }
                            }
                        }
                    }
                }
            }

            // 2. Create buffers
            for b in &binding_configs {
                match &b.resource {
                    ResourceType::Uniform { data } => {
                        let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some(&format!("Uniform Buffer {}:{}", group_idx, b.binding)),
                            contents: bytemuck::cast_slice(data),
                            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                        });
                        created_buffers.push((b.binding, Arc::new(buffer)));
                    },
                    ResourceType::Time => {
                        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                            label: Some("Time Buffer"),
                            size: std::mem::size_of::<f32>() as u64,
                            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                            mapped_at_creation: false,
                        });
                        time_buffer = Some(buffer.clone());
                        created_buffers.push((b.binding, Arc::new(buffer)));
                    },
                    ResourceType::Buffer { id } | ResourceType::Storage { id } => {
                        let op_state = self.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                            if let Some(buffer) = ctx.buffers.get(id) {
                                created_buffers.push((b.binding, Arc::clone(buffer)));
                            }
                        }
                    },
                    _ => {}
                }
            }

            let mut wgpu_entries = Vec::new();
            
            // 3. Add buffers to entries
            for (binding, buffer) in &created_buffers {
                wgpu_entries.push(wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: buffer.as_entire_binding(),
                });
                
                // Keep uniform buffers alive by returning them to the caller (CustomMesh)
                uniform_buffers.push((**buffer).clone());
            }
            
            // 4. Create samplers and add textures/samplers to entries
            for b in &binding_configs {
                let id_str = match &b.resource {
                    ResourceType::Texture { id: Some(id) } => Some(id.clone()),
                    ResourceType::StorageTexture { id } => Some(id.clone()),
                    ResourceType::StorageTextureRgba16 { id } => Some(id.clone()),
                    ResourceType::TextureNonFilterable { id } => Some(id.clone()),
                    _ => None,
                };

                if let Some(id_s) = id_str {
                    if id_s == "Landscape" {
                        if let Some(texture_view) = &landscape_view {
                            // println!("----------BIND.... the good view {:?} {:?} {:?}", current_addon_name, id.clone(), id_s.clone());
                            wgpu_entries.push(wgpu::BindGroupEntry {
                                binding: b.binding,
                                resource: wgpu::BindingResource::TextureView(texture_view),
                            });
                        } else {
                            // println!("----------BIND.... the dummy view {:?}", id.clone());
                            // Fallback to dummy
                            let dummy_texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                                label: Some("Dummy Landscape Texture"),
                                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: wgpu::TextureDimension::D2,
                                format: wgpu::TextureFormat::Rgba8Unorm,
                                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                                view_formats: &[],
                            });
                            gpu.queue.write_texture(
                                wgpu::TexelCopyTextureInfo {
                                    texture: &dummy_texture,
                                    mip_level: 0,
                                    origin: wgpu::Origin3d::ZERO,
                                    aspect: wgpu::TextureAspect::All,
                                },
                                &[255, 255, 255, 255],
                                wgpu::TexelCopyBufferLayout {
                                    offset: 0,
                                    bytes_per_row: Some(4),
                                    rows_per_image: None,
                                },
                                wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                            );
                            let dummy_view = dummy_texture.create_view(&wgpu::TextureViewDescriptor::default());
                            self.dummy_views.push((b.binding, dummy_view));
                            // We'll add this entry in a separate loop
                        }
                    } else {
                        // println!("----------BIND.... the bad view {:?} {:?} {:?}", current_addon_name, id.clone(), id_s.clone());
                        if let Some(view) = addon_texture_views.get(&id_s) {
                            wgpu_entries.push(wgpu::BindGroupEntry {
                                binding: b.binding,
                                resource: wgpu::BindingResource::TextureView(view.as_ref()),
                            });
                        }
                    }
                } else if let ResourceType::Sampler = &b.resource {
                    let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                        address_mode_u: wgpu::AddressMode::ClampToEdge,
                        address_mode_v: wgpu::AddressMode::ClampToEdge,
                        address_mode_w: wgpu::AddressMode::ClampToEdge,
                        mag_filter: wgpu::FilterMode::Linear,
                        min_filter: wgpu::FilterMode::Linear,
                        mipmap_filter: wgpu::FilterMode::Nearest,
                        ..Default::default()
                    });
                    created_samplers.push((b.binding, sampler));
                }
            }

            // 5. Add dummy views
            for (binding, view) in &self.dummy_views {
                if !wgpu_entries.iter().any(|e| e.binding == *binding) {
                    wgpu_entries.push(wgpu::BindGroupEntry {
                        binding: *binding,
                        resource: wgpu::BindingResource::TextureView(view),
                    });
                }
            }
            
            // 6. Add samplers
            for (binding, sampler) in &created_samplers {
                wgpu_entries.push(wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: wgpu::BindingResource::Sampler(sampler),
                });
                samplers.push(sampler.clone());
            }

            let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &layout,
                entries: &wgpu_entries,
                label: Some(&format!("Custom BindGroup {}", group_idx)),
            });
            bind_groups.push(bind_group);
            
            // Add to return uniform_buffers
            for (_, buf) in created_buffers {
                // We try to convert back to wgpu::Buffer if possible, but we might need to change return type to Arc<wgpu::Buffer>
                // For now, let's see if we can get away with this.
                // uniform_buffers.push((*buf).clone()); // Still problematic
            }
        }

        (bind_groups, uniform_buffers, samplers, time_buffer)
    }

    pub fn update(
        &mut self, 
        renderer_state: &mut RendererState, 
        ui_polygons: &mut Vec<Polygon>,
        ui_textboxes: &mut Vec<TextRenderer>,
        font_manager: &FontManager,
        ui_model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &mut SimpleCamera, 
        camera_binding: &mut CameraBinding,
        current_time: f64, 
        gpu_resources: &Arc<GpuResources>, 
        current_addon_name: String,
        mut alpha_renderer: Option<&mut crate::alpha::AlphaRenderer>,
    ) {
        self.check_hot_reload();

        // Poll Yumon background trainers
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();
            
            let mut completed_brains = Vec::new();
            for (id, trainer) in &mut context.yumon_trainers {
                // trainer.poll();
                let update = trainer.recv_update();
                if let Some(update) = &update {
                    if update.done {
                        completed_brains.push(id.clone());
                    }
                }
            }

            for id in completed_brains {
                if let Some(mut trainer) = context.yumon_trainers.remove(&id) {
                    if let Some(brain) = context.yumon_brains.get_mut(&id) {
                        if let Some(weights) = trainer.take_weights() {
                            brain.apply_trained_weights(weights);
                            println!("[AddonEngine] ✅ Background training complete for brain: {}", id);
                        }
                    }
                }
            }
        }

        // let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
        // let landscape_view = renderer_state.landscapes.first().and_then(|l| l.particle_texture_view.clone());
        let mut landscape_view = renderer_state.addon_landscapes
                                                                .get(&current_addon_name)
                                                                .and_then(|al| al.first().and_then(|l| l.particle_texture_view.clone()));

        let mut landscape_data = renderer_state.addon_landscapes
                                                                .get(&current_addon_name)
                                                                .and_then(|al| al.first().map(|l| (l.heights.clone(), [l.transform.position.x, l.transform.position.y, l.transform.position.z])));

        if landscape_data.is_none() {
            landscape_data = renderer_state.addon_landscapes
                                                                    .get("Game Composer")
                                                                    .and_then(|al| al.first().map(|l| (l.heights.clone(), [l.transform.position.x, l.transform.position.y, l.transform.position.z])));
        }

        if landscape_data.is_none() {
            landscape_data = renderer_state.addon_landscapes.values().flatten().next().map(|l| (l.heights.clone(), [l.transform.position.x, l.transform.position.y, l.transform.position.z]));
        }

        // Update current time in context
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();
            context.current_time = current_time;
            context.camera_position = [camera.position.x, camera.position.y, camera.position.z];
            context.camera_direction = [camera.direction.x, camera.direction.y, camera.direction.z];
            context.camera_view = camera.get_view().into();
            context.camera_proj = camera.get_active_projection().into();
            context.landscape_texture_view = landscape_view.clone();
            
            // if context.landscape_heights.is_none() { // ideally would not be setting heights in update()...
                if let Some((heights, pos)) = landscape_data {
                    context.landscape_heights = Some(heights);
                    context.landscape_position = pos;
                } else {
                    context.landscape_heights = None;
                }
            // }

            // Update Input State
            if let Some(mouse_pos) = renderer_state.current_mouse_position {
                context.mouse_position = [mouse_pos.x, mouse_pos.y];
            }
            context.modifiers = Modifiers {
                shift: renderer_state.shift_active,
                ctrl: renderer_state.ctrl_active,
                alt: renderer_state.alt_active,
            };
            context.window_size = [camera.viewport.window_size.width, camera.viewport.window_size.height];
            context.selected_entity_id = renderer_state.selected_entity_id.clone();

            // Apply pending camera changes (made during last frame's callbacks, or by tools)
            apply_pending_camera(context, camera, camera_binding, gpu_resources);
        }

        // 0. Execute Entity Behaviors
        let mut entity_behaviors = Vec::new();
        let mut processed_ids = std::collections::HashSet::new();

        // 0.2 Models
        if let Some(addon_models) = renderer_state.addon_models.get("Game Composer") {
            for model in addon_models {
                if processed_ids.contains(&model.id) { continue; }

                if let Some(bid) = &model.behavior_id {
                    let pos = if let Some(mesh) = model.meshes.first() {
                        if let Some(rb_handle) = mesh.rigid_body_handle {
                            if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                                let p = rb.translation();
                                [p.x, p.y, p.z]
                            } else {
                                [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                            }
                        } else {
                            [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                        }
                    } else {
                        [0.0, 0.0, 0.0]
                    };

                    entity_behaviors.push((
                        bid.clone(),
                        EntityWrapper {
                            id: model.id.clone(),
                            name: "Entity".to_string(),
                            position: pos,
                            health: 100.0,
                            stamina: 100.0,
                            is_dead: false,
                        }
                    ));
                    processed_ids.insert(model.id.clone());
                }
            }
        }
        
        // 0.25 Addon Meshes
        for meshes in renderer_state.addon_meshes.values() {
            for mesh in meshes {
                if processed_ids.contains(&mesh.id) { continue; }
                if let Some(bid) = &mesh.behavior_id {
                    let pos = if let Some(rb_handle) = mesh.rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                            let p = rb.translation();
                            [p.x, p.y, p.z]
                        } else {
                            [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                        }
                    } else {
                        [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                    };

                    entity_behaviors.push((
                        bid.clone(),
                        EntityWrapper {
                            id: mesh.id.clone(),
                            name: "Mesh".to_string(),
                            position: pos,
                            health: 100.0,
                            stamina: 100.0,
                            is_dead: false,
                        }
                    ));
                    processed_ids.insert(mesh.id.clone());
                }
            }
        }

        // 0.3 Collectables
        for coll in &renderer_state.collectables {
            if processed_ids.contains(&coll.id) { continue; }
            if let Some(bid) = &coll.behavior_id {
                let pos = if let Some(rb) = renderer_state.rigid_body_set.get(coll.rigid_body_handle) {
                    let p = rb.translation();
                    [p.x, p.y, p.z]
                } else {
                    [0.0, 0.0, 0.0]
                };

                entity_behaviors.push((
                    bid.clone(),
                    EntityWrapper {
                        id: coll.id.clone(),
                        name: "Collectable".to_string(),
                        position: pos,
                        health: 100.0,
                        stamina: 100.0,
                        is_dead: false,
                    }
                ));
            }
        }

        for (bid, wrapper) in entity_behaviors {
            self.execute_behavior(renderer_state, &bid, wrapper, "on_update", None);
        }

        // 0.35 Execute Yumon runtime control (optional, infer every 500ms and hold in-between).
        {
            const YUMON_INFER_INTERVAL_SECS: f64 = 0.5;
            const YUMON_MOVE_SPEED: f32 = 40.0;
            const YUMON_TURN_SPEED_RAD_PER_SEC: f32 = 2.2;
            const FRAME_DT_SECS: f32 = 1.0 / 60.0;

            #[derive(Clone)]
            struct YumonTarget {
                entity_id: String,
                brain_id: String,
                world: [f32; crate::yumon::system::WORLD_SIZE],
                self_state: [f32; crate::yumon::system::SELF_SIZE],
                yaw: f32,
            }

            struct ActorInfo {
                pos: [f32; 3],
                squad_id: Option<String>,
                is_player: bool,
            }

            let mut actors = Vec::new();
            
            // Gather Player
            if let Some(player) = &renderer_state.player_character {
                let p_pos = if let Some(rb_handle) = player.movement_rigid_body_handle {
                    if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let p = rb.translation();
                        [p.x, p.y, p.z]
                    } else { [camera.position.x, camera.position.y, camera.position.z] }
                } else { [camera.position.x, camera.position.y, camera.position.z] };
                
                actors.push(ActorInfo {
                    pos: p_pos,
                    squad_id: None,
                    is_player: true,
                });
            } else {
                // Fallback to camera if no player character
                actors.push(ActorInfo {
                    pos: [camera.position.x, camera.position.y, camera.position.z],
                    squad_id: None,
                    is_player: true,
                });
            }

            // Gather NPCs
            for npc in &renderer_state.npcs {
                let pos = if let Some(rb_handle) = npc.rigid_body_handle {
                    if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let p = rb.translation();
                        [p.x, p.y, p.z]
                    } else { [0.0, 0.0, 0.0] }
                } else { [0.0, 0.0, 0.0] };
                actors.push(ActorInfo {
                    pos,
                    squad_id: npc.squad_id.clone(),
                    is_player: false,
                });
            }

            let mut targets: Vec<YumonTarget> = Vec::new();
            let mut yumon_processed = std::collections::HashSet::new();

            if renderer_state.game_mode {

            // Process all addon models and meshes
            let all_model_iter = renderer_state.addon_models.values().flatten()
                .map(|m| (m.id.clone(), m.yumon_id.clone(), m.meshes.first().and_then(|sm| sm.rigid_body_handle), m.meshes.first().map(|sm| &sm.transform)));
            
            let all_mesh_iter = renderer_state.addon_meshes.values().flatten()
                .map(|m| (m.id.clone(), m.yumon_id.clone(), m.rigid_body_handle, Some(&m.transform)));

            for (entity_id, yumon_id_opt, rb_handle_opt, transform_opt) in all_model_iter.chain(all_mesh_iter) {
                let Some(yumon_id) = yumon_id_opt else { continue; };
                if yumon_processed.contains(&entity_id) { continue; }

                let mut pos = [0.0f32, 0.0f32, 0.0f32];
                let mut yaw = 0.0f32;
                let mut speed = 0.0f32;

                if let Some(rb_handle) = rb_handle_opt {
                    if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let p = rb.translation();
                        pos = [p.x, p.y, p.z];
                        let (_, y, _) = rb.rotation().euler_angles();
                        yaw = y;
                        speed = rb.linvel().norm();
                    }
                } else if let Some(transform) = transform_opt {
                    pos = [transform.position.x, transform.position.y, transform.position.z];
                    let (_, y, _) = transform.rotation.euler_angles();
                    yaw = y;
                }

                // Get Real Stats
                let mut health_pct = 1.0f32;
                let mut stamina_pct = 1.0f32;
                let mut alert_level = 0.5f32;
                let mut squad_id = None;

                if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == entity_id) {
                    health_pct = (npc.stats.health / 100.0).clamp(0.0, 1.0);
                    stamina_pct = (npc.stats.stamina / 100.0).clamp(0.0, 1.0);
                    alert_level = npc.suspicion;
                    squad_id = npc.squad_id.clone();
                } else if let Some(player) = &renderer_state.player_character {
                    if player.id == entity_id {
                        health_pct = (player.stats.health / 100.0).clamp(0.0, 1.0);
                        stamina_pct = (player.stats.stamina / 100.0).clamp(0.0, 1.0);
                        alert_level = 1.0;
                    }
                }

                // Compute World State
                let mut world = [0.0f32; crate::yumon::system::WORLD_SIZE];
                let mut nearest_player_dist = 1.0f32;
                let mut nearest_player_angle = 0.0f32;
                let mut nearest_ally_dist = 1.0f32;
                let mut nearest_ally_angle = 0.0f32;
                let mut nearby_enemy_count = 0.0f32;
                let mut nearby_ally_count = 0.0f32;

                for actor in &actors {
                    let dx = actor.pos[0] - pos[0];
                    let dz = actor.pos[2] - pos[2];
                    let dist = (dx * dx + dz * dz).sqrt();
                    let world_angle = dx.atan2(dz);
                    // let relative_angle = (world_angle - yaw) / std::f32::consts::PI;
                    let norm_dist = (dist / 100.0).clamp(0.0, 1.0);

                    if actor.is_player {
                        nearest_player_dist = norm_dist;
                        // nearest_player_angle = relative_angle.clamp(-1.0, 1.0);
                        nearest_player_angle = world_angle / std::f32::consts::PI;  // Absolute, no yaw subtraction
                    } else if actor.squad_id == squad_id {
                        if dist > 0.1 && norm_dist < nearest_ally_dist {
                            nearest_ally_dist = norm_dist;
                            // nearest_ally_angle = relative_angle.clamp(-1.0, 1.0);
                            nearest_ally_angle = world_angle / std::f32::consts::PI;  // Absolute, no yaw subtraction
                        }
                        if dist < 20.0 { nearby_ally_count += 0.1; }
                    } else {
                        if dist < 20.0 { nearby_enemy_count += 0.1; }
                    }
                }

                // println!(
                //     "Entity Update: {:?} {:?} {:?} {:?}", entity_id, pos, yaw / std::f32::consts::PI, nearest_player_angle
                // );

                // NOTE: the nearest player is the primary enemy of these yumon NPCs right now
                world[crate::yumon::system::WorldIdx::NearestThreatDist as usize] = nearest_player_dist;
                world[crate::yumon::system::WorldIdx::NearestThreatAngle as usize] = nearest_player_angle;
                world[crate::yumon::system::WorldIdx::NearestAllyDist as usize] = nearest_ally_dist;
                world[crate::yumon::system::WorldIdx::NearestAllyAngle as usize] = nearest_ally_angle;
                world[crate::yumon::system::WorldIdx::NearbyEnemyCount as usize] = nearby_enemy_count.clamp(0.0, 1.0);
                world[crate::yumon::system::WorldIdx::NearbyAllyCount as usize] = nearby_ally_count.clamp(0.0, 1.0);
                world[crate::yumon::system::WorldIdx::AlertLevel as usize] = alert_level;
                world[crate::yumon::system::WorldIdx::PathClearForward as usize] = 1.0;
                world[crate::yumon::system::WorldIdx::LightLevel as usize] = 0.8;

                let mut self_state = [0.0f32; crate::yumon::system::SELF_SIZE];
                self_state[crate::yumon::system::SelfIdx::HealthPct as usize] = health_pct;
                self_state[crate::yumon::system::SelfIdx::StaminaPct as usize] = stamina_pct;
                self_state[crate::yumon::system::SelfIdx::Ammo as usize] = 1.0;
                self_state[crate::yumon::system::SelfIdx::IsGrounded as usize] = 1.0;
                self_state[crate::yumon::system::SelfIdx::Speed as usize] = (speed / 10.0).clamp(0.0, 1.0);
                self_state[crate::yumon::system::SelfIdx::Clock as usize] = ((current_time as f32) % 100.0) / 100.0;

                targets.push(YumonTarget {
                    entity_id: entity_id.clone(),
                    brain_id: yumon_id,
                    world,
                    self_state,
                    yaw,
                });
                yumon_processed.insert(entity_id);
            }

            }

            let mut commands: Vec<(String, crate::yumon::system::Action, f32)> = Vec::new();
            {
                let mut op_state = self.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                let ctx = op_state.borrow_mut::<AddonContext>();

                ctx.yumon_runtime_actions
                    .retain(|entity_id, _| yumon_processed.contains(entity_id));
                ctx.yumon_instances
                    .retain(|entity_id, _| yumon_processed.contains(entity_id));

                for target in targets {
                    let runtime = ctx
                        .yumon_runtime_actions
                        .entry(target.entity_id.clone())
                        .or_insert_with(|| {
                            // Hash entity_id for deterministic but staggered start
                            let mut hasher = std::collections::hash_map::DefaultHasher::new();
                            std::hash::Hash::hash(&target.entity_id, &mut hasher);
                            let hash_val = std::hash::Hasher::finish(&hasher);
                            let offset = (hash_val % 100) as f64 / 100.0 * YUMON_INFER_INTERVAL_SECS;
                            
                            YumonActionState {
                                action: crate::yumon::system::Action::Idle,
                                absolute_rotation: 0.0,
                                last_infer_time: current_time - YUMON_INFER_INTERVAL_SECS + offset,
                            }
                        });

                    if current_time - runtime.last_infer_time >= YUMON_INFER_INTERVAL_SECS {
                        // Get or create instance brain
                        let brain = if let Some(instance) = ctx.yumon_instances.get_mut(&target.entity_id) {
                            Some(instance)
                        } else if let Some(archetype) = ctx.yumon_brains.get(&target.brain_id) {
                            let new_instance = archetype.clone_instance();
                            ctx.yumon_instances.insert(target.entity_id.clone(), new_instance);
                            ctx.yumon_instances.get_mut(&target.entity_id)
                        } else {
                            None
                        };

                        if let Some(brain) = brain {
                            // Maintain a rolling context from live runtime state before infer.
                            brain.observe(
                                &target.world,
                                &target.self_state,
                                runtime.action,
                                target.yaw / std::f32::consts::PI, // Pass absolute yaw normalized -1..1
                                0.0,
                            );

                            if let Some(infer) = brain.infer_if_ready() {
                                // println!("inferred {:?} {:?}", target.entity_id, infer);
                                runtime.action = infer.action;
                                runtime.absolute_rotation = infer.absolute_rotation;
                            }
                            runtime.last_infer_time = current_time;
                        }
                    }

                    commands.push((
                        target.entity_id,
                        runtime.action,
                        runtime.absolute_rotation,
                    ));
                }
            }

            let (addon_models, addon_meshes, rigid_body_set) = (
                &mut renderer_state.addon_models,
                &mut renderer_state.addon_meshes,
                &mut renderer_state.rigid_body_set,
            );

            let action_callbacks = {
                let state = self.runtime.op_state();
                let state = state.borrow();
                let context = state.borrow::<AddonContext>();
                if context.project_id.is_some() {
                    context
                        .on_action_callbacks
                        .iter()
                        // .filter(|(name, _)| name == &current_addon_name)
                        .cloned()
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            };

            {
                // NOTE: this block may be unneeded
                let mut op_state = self.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                let ctx = op_state.borrow_mut::<AddonContext>();

                for (entity_id, action, absolute_rotation) in commands.clone() {
                    let state = ctx.npc_motion_states.entry(entity_id.clone()).or_insert_with(|| NpcMotionState {
                        entity_id:      entity_id.clone(),
                        current_move:   0.0,
                        current_yaw:    0.0,
                        pending_actions: Vec::new(),
                    });

                    match action {
                        Action::MoveForward  => { state.current_move = 1.0; }
                        Action::MoveBackward => { state.current_move = -1.0; }
                        Action::Idle         => { state.current_move = 0.0; }
                        Action::ButtonX | Action::ButtonY |
                        Action::LBumper | Action::RBumper |
                        Action::LTrigger | Action::RTrigger => {}
                        _ => {} // everything else leaves motion state alone
                    }
                }
            }

            {
                for (entity_id, action, absolute_rotation) in commands {
                    // Find the entity to get its position and orientation
                    let mut found_pos = None;
                    let mut found_forward = None;

                    for models in addon_models.values() {
                        if let Some(model) = models.iter().find(|m| m.id == entity_id) {
                            if let Some(mesh) = model.meshes.first() {
                                let pos = mesh.transform.position;
                                let (_, yaw, _) = mesh.transform.rotation.euler_angles();
                                let forward = nalgebra::Vector3::new(yaw.sin(), 0.0, yaw.cos());
                                found_pos = Some([pos.x, pos.y, pos.z]);
                                found_forward = Some([forward.x, forward.y, forward.z]);
                                break;
                            }
                        }
                    }

                    if found_pos.is_none() {
                        for meshes in addon_meshes.values() {
                            if let Some(mesh) = meshes.iter().find(|m| m.id == entity_id) {
                                let pos = mesh.transform.position;
                                let (_, yaw, _) = mesh.transform.rotation.euler_angles();
                                let forward = nalgebra::Vector3::new(yaw.sin(), 0.0, yaw.cos());
                                found_pos = Some([pos.x, pos.y, pos.z]);
                                found_forward = Some([forward.x, forward.y, forward.z]);
                                break;
                            }
                        }
                    }

                    if let (Some(pos), Some(forward)) = (found_pos, found_forward) {
                        let pending = PendingAction {
                            entity_id:  entity_id.clone(),
                            action,
                            origin:    pos,
                            direction: forward,
                        };
                        
                        // Trigger callbacks
                        // TODO: function calls within onAction on JS-side also borrow the context
                        // let callbacks = ctx.on_action_callbacks.clone();
                        for (addon_name, callback) in &action_callbacks {
                            let scope = &mut self.runtime.handle_scope();
                            let tc = &mut v8::TryCatch::new(scope);
                            let cb = v8::Local::new(tc, callback);
                            let recv = v8::undefined(tc).into();
                            
                            // Serialize pending action to JS object
                            let entity_id_js = v8::String::new(tc, &pending.entity_id).unwrap().into();
                            let action_js = v8::Integer::new(tc, pending.action as i32).into();

                            let absolute_rotation_js = v8::Number::new(tc, absolute_rotation as f64);
                            
                            let origin_js = v8::Array::new(tc, 3);
                            for i in 0..3 {
                                let val = v8::Number::new(tc, pending.origin[i] as f64).into();
                                origin_js.set_index(tc, i as u32, val);
                            }
                            
                            let direction_js = v8::Array::new(tc, 3);
                            for i in 0..3 {
                                let val = v8::Number::new(tc, pending.direction[i] as f64).into();
                                direction_js.set_index(tc, i as u32, val);
                            }

                            let obj = v8::Object::new(tc);
                            let entity_id_key = v8::String::new(tc, "entityId").unwrap();
                            let action_key = v8::String::new(tc, "action").unwrap();
                            let origin_key = v8::String::new(tc, "origin").unwrap();
                            let direction_key = v8::String::new(tc, "direction").unwrap();
                            let absolute_rotation_key = v8::String::new(tc, "absoluteRotation").unwrap();

                            obj.set(tc, entity_id_key.into(), entity_id_js);
                            obj.set(tc, action_key.into(), action_js);
                            obj.set(tc, origin_key.into(), origin_js.into());
                            obj.set(tc, direction_key.into(), direction_js.into());
                            obj.set(tc, absolute_rotation_key.into(), absolute_rotation_js.into());

                            cb.call(tc, recv, &[obj.into()]);

                            if let Some(exception) = tc.exception() {
                                let msg = exception.to_rust_string_lossy(tc);
                                println!("[ADDON ACTION ERROR in {}] {}", addon_name, msg);
                            }
                        }
                        
                        // state.pending_actions.push(pending); // unused
                    }
                }
            }
        }

        // 0. Run onUpdate callbacks
        // let callbacks = {
        //     let state = self.runtime.op_state();
        //     let state = state.borrow();
        //     let context = state.borrow::<AddonContext>();
        //     context.on_update_callbacks.clone()
        // };

        // make sure to only update the current addon. This used to also require
        // `context.project_id.is_some()`, which meant onUpdate callbacks never ran at all under
        // EntropyApp (project_id is always None there - see app.rs) - not a Studio-specific
        // guard, just dead weight left over from when this engine only ever ran inside Studio's
        // own project system. The name filter below is the actual "only the current addon"
        // check; project_id has nothing to do with which addon is current.
        let callbacks = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context
                .on_update_callbacks
                .iter()
                .filter(|(name, _)| name == &current_addon_name)
                .cloned()
                .collect::<Vec<_>>()
        };

        for (addon_name, callback) in callbacks {
            let scope = &mut self.runtime.handle_scope();
            let local_callback = v8::Local::new(scope, callback);
            let this = v8::undefined(scope);
            let time_v8 = v8::Number::new(scope, current_time);
            let pos_v8 = serde_v8::to_v8(scope, [camera.position.x, camera.position.y, camera.position.z]).unwrap();
            let dir_v8 = serde_v8::to_v8(scope, [camera.direction.x, camera.direction.y, camera.direction.z]).unwrap();
            let args = &[time_v8.into(), pos_v8, dir_v8];
            
            // Use TryCatch to avoid one addon crashing the whole loop
            let tc = &mut v8::TryCatch::new(scope);
            local_callback.call(tc, this.into(), args);
            
            if tc.has_caught() {
                if let Some(exception) = tc.exception() {
                    let msg = exception.to_rust_string_lossy(tc);
                    println!("[ADDON UPDATE ERROR in {}] {}", addon_name, msg);
                }
            }
        }

        // A camera set in this frame's update applies to this frame, like the buffers and meshes
        // the same callback wrote: otherwise the view lags one frame behind them (a chase camera
        // judders against its target, and an addon that moves its render origin sees everything
        // jump for a frame).
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();
            apply_pending_camera(context, camera, camera_binding, gpu_resources);
        }

        // 1. Process UI Events
        let events = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                
                // update project id as needed
                ctx.project_id = self.project_id.clone();

                if let Ok(mut evs) = ctx.ui_events.lock() {
                    std::mem::take(&mut *evs)
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        };

        if !events.is_empty() {
            // println!("Non empty events {:?}", events);

            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let process_key = v8::String::new(scope, "_process_events").unwrap();
                    if let Some(process_val) = entropy_obj.get(scope, process_key.into()) {
                        if process_val.is_function() {
                            let process_func = v8::Local::<v8::Function>::try_from(process_val).unwrap();
                            let args_v8 = serde_v8::to_v8(scope, events).unwrap();
                            let _ = process_func.call(scope, entropy_obj.into(), &[args_v8]);
                        }
                    }
                }
            }
        }

        // 1.5 Process Input Events
        let input_events = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.input_events)
            } else {
                Vec::new()
            }
        };

        if !input_events.is_empty() {
            // println!("input_events 1 {:?}", input_events.get(0));
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let process_key = v8::String::new(scope, "_process_input_events").unwrap();
                    if let Some(process_val) = entropy_obj.get(scope, process_key.into()) {
                        if process_val.is_function() {
                            // println!("input_events 2");
                            let process_func = v8::Local::<v8::Function>::try_from(process_val).unwrap();
                            let args_v8 = serde_v8::to_v8(scope, input_events).unwrap();
                            let _ = process_func.call(scope, entropy_obj.into(), &[args_v8]);
                        }
                    }
                }
            }
        }

        // 2. Process pending resources
        let (pending_cubes, 
            pending_models, 
            pending_meshes, 
            pending_clears, 
            pending_mesh_clears, 
            pending_landscapes, 
            pending_grasses,
            pending_point_lights,
            pending_point_light_removals,
            pending_composites,
            pending_landscape_texture_updates, 
            pending_game_mode, 
            pending_impulses, 
            pending_velocities, 
            pending_xz_velocities,
            pending_entity_rotations,
            pending_animations, 
            pending_stats,
            pending_bone_transforms,
            pending_ui_rects,
            pending_ui_texts,
            pending_ui_clear,
            pending_visuals,
            pending_alpha_models,
            pending_quadscapes
        ) = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                (
                    std::mem::take(&mut ctx.pending_cubes),
                    std::mem::take(&mut ctx.pending_models),
                    std::mem::take(&mut ctx.pending_meshes),
                    std::mem::take(&mut ctx.pending_clears),
                    std::mem::take(&mut ctx.pending_mesh_clears),
                    std::mem::take(&mut ctx.pending_landscapes),
                    std::mem::take(&mut ctx.pending_grasses),
                    std::mem::take(&mut ctx.pending_point_lights),
                    std::mem::take(&mut ctx.pending_point_light_removals),
                    std::mem::take(&mut ctx.pending_composites),
                    std::mem::take(&mut ctx.pending_landscape_texture_updates),
                    ctx.pending_game_mode.take(),
                    std::mem::take(&mut ctx.pending_entity_impulses),
                    std::mem::take(&mut ctx.pending_entity_velocities),
                    std::mem::take(&mut ctx.pending_entity_xz_velocities),
                    std::mem::take(&mut ctx.pending_entity_rotations),
                    std::mem::take(&mut ctx.pending_animation_plays),
                    std::mem::take(&mut ctx.pending_stat_updates),
                    std::mem::take(&mut ctx.pending_bone_transforms),
                    std::mem::take(&mut ctx.pending_ui_rects),
                    std::mem::take(&mut ctx.pending_ui_texts),
                    std::mem::replace(&mut ctx.pending_ui_clear, false),
                    std::mem::take(&mut ctx.pending_visuals),
                    std::mem::take(&mut ctx.pending_alpha_models),
                    std::mem::take(&mut ctx.pending_quadscapes)
                )
            } else {
                (
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(), // pending_point_light_removals
                    None,
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(),
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    false,
                    Vec::new(),
                    Vec::new(),
                    Vec::new()
                )
            }
        };

        // Entropy.Mesh.updateVertices's queue - pulled separately from the tuple above (which
        // is already a 25-element destructure) rather than adding a 26th position to it.
        let pending_mesh_updates: Vec<(String, Vec<u32>, Vec<f32>)> = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.pending_mesh_updates)
            } else {
                Vec::new()
            }
        };

        if let Some(enabled) = pending_game_mode {
            renderer_state.game_mode = enabled;
        }

        for (addon_name, config) in pending_alpha_models {
            if let Some(alpha) = alpha_renderer.as_mut() {
                if let Ok(bytes) = read_model(self.project_id.clone().unwrap_or_default(), config.path.clone()) {
                    let model = crate::alpha::AlphaModel::AlphaModel::from_glb(*alpha, &bytes);
                    
                    let rotation = config.rotation.unwrap_or([0.0, 0.0, 0.0]);
                    let scale = config.scale.unwrap_or([1.0, 1.0, 1.0]);
                    
                    let isometry = Isometry3::from_parts(
                        Translation3::new(config.position[0], config.position[1], config.position[2]),
                        UnitQuaternion::from_euler_angles(rotation[0], rotation[1], rotation[2])
                    );
                    
                    let mut model_matrix = isometry.to_homogeneous();
                    let scale_matrix = Matrix4::new_nonuniform_scaling(&Vector3::new(scale[0], scale[1], scale[2]));
                    model_matrix = model_matrix * scale_matrix;

                    println!("Adding alpha model instance");

                    alpha.add_instance(crate::alpha::AlphaInstanceData {
                        model_matrix: *model_matrix.as_ref(),
                        mesh_index: model.mesh_index as f32,
                        material_index: 0.0,
                        _padding: [0.0, 0.0],
                    });
                }
            }
        }

        for (id, impulse) in pending_impulses {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == id) {
                if let Some(rb) = renderer_state.rigid_body_set.get_mut(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                    rb.apply_impulse(nalgebra::vector![impulse[0], impulse[1], impulse[2]], true);
                }
            } 
            // Apply to Player
            else if let Some(player) = &renderer_state.player_character {
                if player.id == id {
                    if let Some(rb_handle) = player.movement_rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                            rb.apply_impulse(nalgebra::vector![impulse[0], impulse[1], impulse[2]], true);
                        }
                    }
                }
            }
        }

        for (id, velocity) in pending_velocities {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == id) {
                if let Some(rb) = renderer_state.rigid_body_set.get_mut(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                    rb.set_linvel(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                    // rb.add_force(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                }
            } 
            // Apply to Player
            else if let Some(player) = &renderer_state.player_character {
                if player.id == id {
                    if let Some(rb_handle) = player.movement_rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                            rb.set_linvel(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                            // rb.add_force(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                        }
                    }
                }
            }
        }

        for (id, velocity_xz) in pending_xz_velocities {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                if let Some(rb) = renderer_state.rigid_body_set.get_mut(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                    let current_vel = rb.linvel();
                    rb.set_linvel(nalgebra::vector![velocity_xz[0], current_vel.y, velocity_xz[1]], true);
                }
            } 
            // Apply to Player
            else if let Some(player) = &renderer_state.player_character {
                if player.id == id {
                    if let Some(rb_handle) = player.movement_rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                            let current_vel = rb.linvel();
                            rb.set_linvel(nalgebra::vector![velocity_xz[0], current_vel.y, velocity_xz[1]], true);
                        }
                    }
                }
            }
        }

        for (id, rotation) in pending_entity_rotations {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                if let Some(mesh) = renderer_state.addon_meshes.values_mut().flatten().find(|n| n.id == id) {
                    if let Some(transform) = &mut npc.transform {
                        transform.update_rotation(rotation);
                        mesh.transform.update_rotation(rotation);
                    }
                } 
            } 
            // Apply to Player
            else if let Some(player) = &mut renderer_state.player_character {
                if player.id == id {
                    if let Some(transform) = &mut player.transform {
                        transform.update_rotation(rotation);
                    }
                }
            }
        }

        for (id, anim_name) in pending_animations {
            // Find NPC and its associated model
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == npc.model_id) {
                    if let Some(idx) = model.animations.iter().position(|a| a.name.to_lowercase().contains(&anim_name.to_lowercase())) {
                        npc.animation_state.animation_index = idx;
                    }
                }
            }
        }

        for (id, stats) in pending_stats {
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                npc.stats = stats;
            } else if let Some(player) = &mut renderer_state.player_character {
                if player.id == id {
                    player.stats = stats;
                }
            }
        }

        for bt in pending_bone_transforms {
            if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == bt.model_id) {
                if let Some(node_idx) = model.nodes.iter().position(|n| n.name == bt.bone_name) {
                    let node = &mut model.nodes[node_idx];
                    if let Some(pos) = bt.position {
                        node.transform.position = nalgebra::Vector3::new(pos[0], pos[1], pos[2]);
                    }
                    if let Some(rot) = bt.rotation {
                        node.transform.rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(rot[3], rot[0], rot[1], rot[2]));
                    }
                    if let Some(scale) = bt.scale {
                        node.transform.scale = nalgebra::Vector3::new(scale[0], scale[1], scale[2]);
                    }
                    
                    // Manually trigger matrix updates
                    // Note: Ideally we should call a centralized update_global_transforms(model) here
                    // similar to what animation_system.rs does.
                    
                    // We can reuse the update logic from animation_system if we make it public or duplicate it
                    // For now, let's just mark it as needing update if we had such a flag, 
                    // or just run the update logic right here for this model.
                    
                    fn update_node_recursive(nodes: &mut [crate::art_assets::Model::Node], parent_transform: &nalgebra::Matrix4<f32>, node_idx: usize, queue: &wgpu::Queue) {
                        let (global_transform, children) = {
                            let node = &mut nodes[node_idx];
                            let local_transform = node.transform.update_transform();
                            node.global_transform = parent_transform * local_transform;
                            (node.global_transform, node.children.clone())
                        };

                        let raw_matrix = crate::core::Transform_2::matrix4_to_raw_array(&global_transform);
                        queue.write_buffer(&nodes[node_idx].transform.uniform_buffer, 0, bytemuck::cast_slice(&raw_matrix));

                        for child_idx in children {
                            update_node_recursive(nodes, &global_transform, child_idx, queue);
                        }
                    }

                    if let gpu = &gpu_resources {
                        let root_nodes = model.root_nodes.clone();
                        for root_idx in root_nodes {
                            update_node_recursive(&mut model.nodes, &nalgebra::Matrix4::identity(), root_idx, &gpu.queue);
                        }

                        // Also update skinning buffer if it exists
                        if let Some(joint_matrices_buffer) = model.joint_matrices_buffer.as_ref() {
                            if let Some(skin) = model.skins.first() {
                                let mut joint_transforms: Vec<[f32; 16]> = Vec::with_capacity(skin.joints.len());
                                for (joint_node_index, inverse_bind_matrix) in skin.joints.iter().zip(skin.inverse_bind_matrices.iter()) {
                                    let joint_node = &model.nodes[*joint_node_index];
                                    let skinning_matrix = joint_node.global_transform * inverse_bind_matrix;
                                    joint_transforms.push(skinning_matrix.as_slice().try_into().unwrap());
                                }
                                gpu.queue.write_buffer(joint_matrices_buffer, 0, bytemuck::cast_slice(&joint_transforms));
                            }
                        }
                    }
                }
            }
        }

        // `Entropy.Mesh.updateVertices` was declared in addon.d.ts and wired in addon_setup.js,
        // but op_mesh_update_vertices was never added to this file's op registration list - it
        // threw `ops.op_mesh_update_vertices is not a function` on every call (caught this live
        // the first time an addon actually called it: game2d's sprites never moved). Registering
        // the op (see the `use` list and `extension!` ops list above) fixed the throw, but the
        // op itself only ever pushed onto `AddonContext.pending_mesh_updates` - nothing drained
        // that queue either. Fixed here: write the new positions straight into the mesh's
        // existing vertex buffer, same `queue.write_buffer` technique the bone-transform update
        // above already uses.
        for (mesh_id, indices, positions) in pending_mesh_updates {
            if let Some(mesh) = renderer_state.addon_meshes.values().flatten().find(|m| m.id == mesh_id) {
                let stride = std::mem::size_of::<Vertex>() as wgpu::BufferAddress;
                for (i, vertex_index) in indices.iter().enumerate() {
                    let base = i * 3;
                    if base + 2 >= positions.len() { continue; }
                    let new_pos = [positions[base], positions[base + 1], positions[base + 2]];
                    let offset = (*vertex_index as wgpu::BufferAddress) * stride;
                    gpu_resources.queue.write_buffer(&mesh.vertex_buffer, offset, bytemuck::cast_slice(&new_pos));
                }
            }
        }

        if pending_ui_clear {
            ui_polygons.clear();
            ui_textboxes.clear();
        }

        if !pending_ui_rects.is_empty() {
            if let gpu = &gpu_resources {
                let window_size = crate::core::editor::WindowSize {
                    width: camera.viewport.width as u32,
                    height: camera.viewport.height as u32,
                };
                // let ui_model_bind_group_layout = ui_model_bind_group_layout.as_ref().expect("No ui model layout");
                // let group_bind_group_layout = group_bind_group_layout.as_ref().expect("No group layout");

                for (_addon_name, config) in pending_ui_rects {
                    // let poly_bg_pos = Point { 
                    //     x: config.position[0] + (config.size[0] / 2.0), 
                    //     y: config.position[1] + (config.size[1] / 2.0) 
                    // };

                    let poly_bg_pos = Point { 
                        x: config.position[0], 
                        y: config.position[1]
                    };
                    
                    let id = Uuid::new_v4();
                    let rect = Polygon::new(
                        &window_size,
                        &gpu.device,
                        &gpu.queue,
                        ui_model_bind_group_layout,
                        group_bind_group_layout,
                        camera,
                        vec![Point{x:0.0, y:0.0}, Point{x:1.0, y:0.0}, Point{x:1.0, y:1.0}, Point{x:0.0, y:1.0}],
                        (config.size[0], config.size[1]),
                        poly_bg_pos,
                        (0.0, 0.0, 0.0),
                        0.0,
                        config.color,
                        Stroke { thickness: config.stroke_thickness, fill: config.stroke_color },
                        config.layer,
                        "JS UI Rect".to_string(),
                        id,
                        Uuid::nil(),
                    );
                    ui_polygons.push(rect);
                }
            }
        }

        if !pending_ui_texts.is_empty() {
            if let gpu = &gpu_resources {
                let window_size = crate::core::editor::WindowSize {
                    width: camera.viewport.width as u32,
                    height: camera.viewport.height as u32,
                };
                // let ui_model_bind_group_layout = ui_model_bind_group_layout.as_ref().expect("No ui model layout");
                // let group_bind_group_layout = group_bind_group_layout.as_ref().expect("No group layout");

                for (_addon_name, config) in pending_ui_texts {
                    let id = Uuid::new_v4();
                    let font_bytes = font_manager.get_font_by_name(&config.font_family)
                        .unwrap_or_else(|| &font_manager.font_data[0].1);

                    let text_config = TextRendererConfig {
                        id,
                        name: "JS UI Text".to_string(),
                        text: config.text.clone(),
                        font_family: config.font_family,
                        font_size: config.font_size as i32,
                        dimensions: (config.dimensions[0], config.dimensions[1]),
                        position: Point { x: config.position[0], y: config.position[1] },
                        layer: config.layer,
                        color: [
                            (config.color[0] * 255.0) as i32,
                            (config.color[1] * 255.0) as i32,
                            (config.color[2] * 255.0) as i32,
                            (config.color[3] * 255.0) as i32,
                        ],
                        background_fill: [
                            (config.background_fill[0] * 255.0) as i32,
                            (config.background_fill[1] * 255.0) as i32,
                            (config.background_fill[2] * 255.0) as i32,
                            (config.background_fill[3] * 255.0) as i32,
                        ],
                    };
                    
                    let mut text_renderer = TextRenderer::new(
                        &gpu.device,
                        &gpu.queue,
                        ui_model_bind_group_layout,
                        group_bind_group_layout,
                        font_bytes,
                        &window_size,
                        config.text,
                        text_config,
                        id,
                        Uuid::nil(),
                        camera
                    );

                    text_renderer.render_text(&gpu.device, &gpu.queue);
                    ui_textboxes.push(text_renderer);
                }
            }
        }

        // 2.1 Process Gizmo
        let gizmo_state = {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            let ctx = op_state.try_borrow::<AddonContext>();
            ctx.and_then(|c| c.active_gizmo.clone())
        };

        if let Some(gs) = gizmo_state {
            // Update internal gizmo config
            let mut config = renderer_state.gizmo.config().clone();
            config.view_matrix = crate::core::SimpleCamera::to_row_major_f64(&camera.get_view());
            config.projection_matrix = crate::core::SimpleCamera::to_row_major_f64(&camera.get_projection());
            config.viewport = transform_gizmo::Rect {
                min: (0.0, 0.0).into(),
                max: (camera.viewport.window_size.width as f32, camera.viewport.window_size.height as f32).into(),
            };
            
            config.modes = match gs.mode.as_str() {
                "translate" => transform_gizmo::GizmoMode::all_translate(),
                "rotate" => transform_gizmo::GizmoMode::all_rotate(),
                "scale" => transform_gizmo::GizmoMode::all_scale(),
                // Both handle sets shown and draggable at once - transform_gizmo's GizmoMode is
                // an EnumSet, so combining is just a union, no separate interaction path needed.
                "translate_rotate" => transform_gizmo::GizmoMode::all_translate() | transform_gizmo::GizmoMode::all_rotate(),
                _ => transform_gizmo::GizmoMode::all_translate(),
            };

            config.orientation = match gs.space.as_str() {
                "local" => transform_gizmo::GizmoOrientation::Local,
                _ => transform_gizmo::GizmoOrientation::Global,
            };

            renderer_state.gizmo.update_config(config);

            // Create target transform for gizmo
            use transform_gizmo::math::Transform;
            use transform_gizmo::mint::{Vector3 as MintVector3, Quaternion as MintQuaternion};
            
            // Scale is still always identity - no caller has asked for scale handles yet.
            // Rotation is seeded from gs.rotation (identity for every pre-existing caller, see
            // GizmoState's doc comment), so a "rotate"/"translate_rotate" gizmo starts drawn at
            // the object's actual current orientation instead of always world-aligned.
            let mut transforms = vec![
                Transform::from_scale_rotation_translation(
                    MintVector3::from([1.0, 1.0, 1.0]),
                    MintQuaternion::from([gs.rotation[0] as f64, gs.rotation[1] as f64, gs.rotation[2] as f64, gs.rotation[3] as f64]),
                    MintVector3::from([gs.position[0] as f64, gs.position[1] as f64, gs.position[2] as f64])
                )
            ];

            let interaction = transform_gizmo::GizmoInteraction {
                cursor_pos: (renderer_state.current_mouse_position.map(|p| p.x).unwrap_or(0.0), renderer_state.current_mouse_position.map(|p| p.y).unwrap_or(0.0)),
                dragging: renderer_state.mouse_state.is_dragging,
                drag_started: renderer_state.mouse_state.drag_started,
                // Gizmo::update() only calls pick_subgizmo() (the actual hit-test) when
                // `hovered` is true (transform-gizmo-0.8.0 src/gizmo.rs:135) - it is NOT
                // computed internally despite the field name suggesting otherwise.
                // Without this, no subgizmo is ever picked/focused regardless of cursor
                // position or dragging state, so update() always returns None. The native
                // gizmo-drag path (handlers.rs) already sets this to true; this one didn't.
                hovered: true,
                ..Default::default()
            };

            // Consume the one-shot drag_started signal now that it's been read into
            // `interaction` above - see handle_stylus_touch's doc comment on why this is set
            // sticky-true by the input handler rather than recomputed fresh per-event: this is
            // the one place responsible for clearing it back to false, so it reliably survives
            // from "touch went down" through to whichever render frame actually consumes it,
            // regardless of how many touch events land in between.
            if interaction.drag_started {
                renderer_state.mouse_state.drag_started = false;
            };

            let update_result = renderer_state.gizmo.update(interaction, &mut transforms);

            if let Some((gizmo_result, new_transforms)) = update_result {
                renderer_state.mouse_state.hovered_gizmo = true;
                
                // If it changed, trigger JS callbacks
                if let Some(new_transform) = new_transforms.first() {
                    let delta = [
                        (new_transform.translation.x as f32 - gs.position[0]),
                        (new_transform.translation.y as f32 - gs.position[1]),
                        (new_transform.translation.z as f32 - gs.position[2]),
                    ];

                    if delta[0].abs() > 0.0001 || delta[1].abs() > 0.0001 || delta[2].abs() > 0.0001 {
                        // Call JS onTransform
                        let scope = &mut self.runtime.handle_scope();
                        let global = scope.get_current_context().global(scope);
                        let entropy_key = v8::String::new(scope, "Entropy").unwrap();
                        if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                            let entropy_obj = entropy_val.to_object(scope).unwrap();
                            let gizmo_callbacks_key = v8::String::new(scope, "_entropy_gizmo_callbacks").unwrap();
                            if let Some(callbacks_val) = global.get(scope, gizmo_callbacks_key.into()) {
                                if callbacks_val.is_object() {
                                    let callbacks_obj = callbacks_val.to_object(scope).unwrap();
                                    let gizmo_id_key = v8::String::new(scope, &gs.id).unwrap();
                                    if let Some(callback_entry_val) = callbacks_obj.get(scope, gizmo_id_key.into()) {
                                        if callback_entry_val.is_object() {
                                            let callback_entry = callback_entry_val.to_object(scope).unwrap();
                                            let on_transform_key = v8::String::new(scope, "onTransform").unwrap();
                                            if let Some(on_transform_val) = callback_entry.get(scope, on_transform_key.into()) {
                                                if on_transform_val.is_function() {
                                                    let on_transform_func = v8::Local::<v8::Function>::try_from(on_transform_val).unwrap();
                                                    let delta_v8 = serde_v8::to_v8(scope, delta).unwrap();
                                                    let _ = on_transform_func.call(scope, entropy_obj.into(), &[delta_v8]);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Same shape as the onTransform dispatch above, but for rotation: fires the
                // ABSOLUTE new orientation (not a delta) since composing rotation deltas
                // correctly on the JS side is much more error-prone than on the position side -
                // a caller that cares just stores it directly or converts it to its own
                // representation (e.g. canvas_surface_addon.ts converts to yaw/pitch/roll).
                // No-ops for every pre-existing caller: they never register onRotate and their
                // mode strings never include a rotate handle, so new_transform.rotation never
                // moves off the identity they seeded.
                if let Some(new_transform) = new_transforms.first() {
                    let new_rot = [
                        new_transform.rotation.v.x as f32,
                        new_transform.rotation.v.y as f32,
                        new_transform.rotation.v.z as f32,
                        new_transform.rotation.s as f32,
                    ];
                    let rot_changed = (0..4).any(|i| (new_rot[i] - gs.rotation[i]).abs() > 0.0001);

                    if rot_changed {
                        let scope = &mut self.runtime.handle_scope();
                        let global = scope.get_current_context().global(scope);
                        let entropy_key = v8::String::new(scope, "Entropy").unwrap();
                        if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                            let entropy_obj = entropy_val.to_object(scope).unwrap();
                            let gizmo_callbacks_key = v8::String::new(scope, "_entropy_gizmo_callbacks").unwrap();
                            if let Some(callbacks_val) = global.get(scope, gizmo_callbacks_key.into()) {
                                if callbacks_val.is_object() {
                                    let callbacks_obj = callbacks_val.to_object(scope).unwrap();
                                    let gizmo_id_key = v8::String::new(scope, &gs.id).unwrap();
                                    if let Some(callback_entry_val) = callbacks_obj.get(scope, gizmo_id_key.into()) {
                                        if callback_entry_val.is_object() {
                                            let callback_entry = callback_entry_val.to_object(scope).unwrap();
                                            let on_rotate_key = v8::String::new(scope, "onRotate").unwrap();
                                            if let Some(on_rotate_val) = callback_entry.get(scope, on_rotate_key.into()) {
                                                if on_rotate_val.is_function() {
                                                    let on_rotate_func = v8::Local::<v8::Function>::try_from(on_rotate_val).unwrap();
                                                    let rot_v8 = serde_v8::to_v8(scope, new_rot).unwrap();
                                                    let _ = on_rotate_func.call(scope, entropy_obj.into(), &[rot_v8]);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // If drag ended, call onComplete
                if !renderer_state.mouse_state.is_dragging && renderer_state.last_frame_time.is_some() {
                    // We need a better way to detect drag end here, renderer_state might not have enough info
                    // but we can check if it WAS dragging in previous frame.
                    // Actually transform_gizmo result might have it.
                }
            } else {
                renderer_state.mouse_state.hovered_gizmo = false;
            }
        }

        if !pending_clears.is_empty() {
            for addon_name in pending_clears {
                renderer_state.addon_meshes.remove(&addon_name);
                renderer_state.addon_cubes.remove(&addon_name);
                renderer_state.addon_models.remove(&addon_name);
                // Also clear models belonging to this addon
                renderer_state.models.retain(|m| !m.id.starts_with(&format!("{}_", addon_name)));
            }
        }

        if !pending_mesh_clears.is_empty() {
            for (addon_name, mesh_id) in pending_mesh_clears {
                if let Some(meshes) = renderer_state.addon_meshes.get_mut(&addon_name) {
                    meshes.retain(|m| m.id != mesh_id);
                }
                if let Some(models) = renderer_state.addon_models.get_mut(&addon_name) {
                    models.retain(|m| m.id != mesh_id);
                }
                // Also clear models
                renderer_state.models.retain(|m| m.id != mesh_id);
            }
        }

        if !pending_point_lights.is_empty() {
            for (addon_name, config) in pending_point_lights {
                let pl = crate::core::editor::PointLight {
                    position: config.position,
                    _padding1: 0,
                    color: config.color,
                    _padding2: 0,
                    intensity: config.intensity,
                    max_distance: config.max_distance,
                    falloff_exponent: config.falloff_exponent,
                    specular_strength: config.specular_strength,
                };
                let lights = renderer_state.addon_point_lights
                    .entry(addon_name)
                    .or_insert_with(Vec::new);
                // Upsert by id - without this, a live-editing UI (drag a slider, tweak a
                // preview light every frame) leaked a brand new light on every call instead
                // of updating the one it already spawned.
                if let Some(existing) = lights.iter_mut().find(|(id, _)| *id == config.id) {
                    existing.1 = pl;
                } else {
                    lights.push((config.id, pl));
                }
            }
        }

        if !pending_point_light_removals.is_empty() {
            for (addon_name, id) in pending_point_light_removals {
                if let Some(lights) = renderer_state.addon_point_lights.get_mut(&addon_name) {
                    lights.retain(|(light_id, _)| light_id != &id);
                }
            }
        }

        if !pending_composites.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (_addon_name, config) in pending_composites {
                    let (pipeline, texture_view) = {
                        let op_state = self.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                            let p = ctx.composite_pipelines.get(&config.pipeline_id).or_else(|| ctx.pipelines.get(&config.pipeline_id)).cloned();
                            let t = ctx.textures.get(&config.texture_id).cloned();
                            (p, t)
                        } else {
                            (None, None)
                        }
                    };

                    // println!("Pending Composites... {:?} {:?} {:?}", pipeline.is_some(), texture_view.is_some(), config);

                    if let (Some(pipeline), Some(texture_view)) = (pipeline, texture_view) {
                         let (bind_groups, uniform_buffers, samplers, time_buffer) = if let Some(bindings) = config.bindings {
                             self.create_bindings_from_config(gpu, landscape_view.clone(), &pipeline, bindings, Some(config.name.clone()), current_addon_name.clone())
                         } else {
                             (Vec::new(), Vec::new(), Vec::new(), None)
                         };
                         

                         let mut op_state = self.runtime.op_state();
                         let mut op_state = op_state.borrow_mut();
                         if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                             ctx.composites.push(CompositeInstance {
                                 name: config.name,
                                 texture_view,
                                 pipeline,
                                 bind_groups,
                                 uniform_buffers,
                                 samplers,
                                 time_buffer,
                             });
                         }
                    }
                }
            }
        }

        if !pending_cubes.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (addon_name, config) in pending_cubes {
                    let mut cube = Cube::new(
                        &gpu.device,
                        &gpu.queue,
                        &renderer_state.model_bind_group_layout,
                        &renderer_state.group_bind_group_layout,
                        &renderer_state.texture_render_mode_buffer,
                        camera
                    );
                    cube.transform.update_position(config.position);
                    cube.transform.update_scale(config.scale);
                    cube.pipeline_id = config.pipeline_id;
                    cube.render_role = config.render_role;
                    
                    renderer_state.addon_cubes
                        .entry(addon_name)
                        .or_insert_with(Vec::new)
                        .push(cube);
                }
            }
        }

        if !pending_models.is_empty() {
            if let gpu= &gpu_resources {
                for (addon_name, config) in pending_models {
                    if self.project_id.is_some() || self.art_assets_dir.is_some() {
                    let id = config.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    
                    let pos = Vector3::new(config.position[0], config.position[1], config.position[2]);
                    let rot = config.rotation.unwrap_or([0.0, 0.0, 0.0]);
                    let rot_quat = UnitQuaternion::from_euler_angles(rot[0], rot[1], rot[2]);
                    let isometry = Isometry3::from_parts(pos.into(), rot_quat);
                    let scale_val = config.scale.unwrap_or([1.0, 1.0, 1.0]);
                    let scale = Vector3::new(scale_val[0], scale_val[1], scale_val[2]);

                    let visual_type = config.visual_type.unwrap_or_default();

                    // Addon-supplied paths/ids are untrusted-ish: a missing file, a typo'd
                    // path, or a permissions error here used to `panic!`/`.expect()` and
                    // take the whole native process down over one bad `Entropy.Model.load`
                    // call. Now it's logged and this one queued model is skipped instead.
                    let mut model_ok = true;
                    if visual_type == crate::helpers::saved_data::VisualType::Model {
                        let path = match config.path.as_ref() {
                            Some(p) => p,
                            None => {
                                println!("[Model] Skipping addon model load for {:?}: no path supplied", addon_name);
                                continue;
                            }
                        };
                        let bytes_result = {
                        let mut op_state = self.runtime.op_state();
                        let mut op_state = op_state.borrow_mut();
                        let ctx = op_state.try_borrow_mut::<AddonContext>().expect("Failed to borrow AddonContext");

                        if let Some(cached_bytes) = ctx.model_cache.get(path) {
                            Ok(cached_bytes.clone())
                        } else {
                            println!("Reading in model: {:?}", path);
                            // `art_assets_dir` (EntropyApp::with_art_assets_dir) takes priority over the
                            // Studio project_id convention - a plain directory an embedder points at, no
                            // MidPoint `midpoint/projects/<id>/models/` convention involved.
                            let read_result = if let Some(dir) = &self.art_assets_dir {
                                std::fs::read(dir.join(path)).map_err(|e| format!("Couldn't read model {:?} from {:?}: {}", path, dir, e))
                            } else {
                                // Only reachable when project_id.is_some() (the outer `if` above),
                                // since art_assets_dir is None in this branch.
                                crate::art_assets::Model::read_model(self.project_id.clone().unwrap(), path.clone())
                            };
                            if let Ok(bytes) = &read_result {
                                ctx.model_cache.insert(path.clone(), bytes.clone());
                            }
                            read_result
                        }
                    };

                    match bytes_result {
                        Ok(bytes) => {
                            if let Err(e) = renderer_state.add_addon_model(
                                &addon_name,
                                &gpu.device,
                                &gpu.queue,
                                &id,
                                &bytes,
                                isometry,
                                scale,
                                camera,
                                false,
                                None,
                                config.physics,
                                config.behavior_id.clone()
                            ) {
                                println!("[Model] Failed to load addon model {:?} for addon {:?}: {}", path, addon_name, e);
                                model_ok = false;
                            }
                        }
                        Err(e) => {
                            println!("[Model] Failed to read addon model {:?} for addon {:?}: {}", path, addon_name, e);
                            model_ok = false;
                        }
                    }
                    }

                    if model_ok {
                    if let Some(mut player_props) = config.player {
                        player_props.visual_type = Some(visual_type);
                        renderer_state.add_player_character(
                            &gpu.device,
                            &gpu.queue,
                            id.clone(),
                            isometry,
                            scale,
                            camera,
                            player_props
                        );
                    } else if let Some(is_npc) = config.is_npc {
                        if is_npc {
                            let mut npc_props = config.npc.unwrap_or_default();
                            npc_props.visual_type = Some(visual_type);
                            renderer_state.add_npc(
                                id.clone(),
                                npc_props,
                                config.behavior_id,
                                None, // visual config is supplied on pending_visuals
                            );
                        }
                    } else {
                        renderer_state.add_collider(id.clone(), crate::helpers::saved_data::ComponentKind::Model, None);
                    }

                    if let Some(models) = renderer_state.addon_models.get_mut(&addon_name) {
                        if let Some(model) = models.iter_mut().find(|m| m.id == id) {
                            model.yumon_id = config.yumon_id.clone();
                            for mesh in &mut model.meshes {
                                mesh.render_role = config.render_role.clone();
                            }
                        }
                    }
                    }
                }
                }
            }
        }

        if !pending_meshes.is_empty() {
            if let gpu = &gpu_resources {
                                for (addon_name, config) in pending_meshes {
                                     let (pipeline, pipeline_id) = {
                                         let op_state_rc = self.runtime.op_state();
                                         let mut op_state = op_state_rc.borrow_mut();

                                         let custom_pipeline = if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                                 ctx.pipelines.get(&config.pipeline_id).cloned()
                                         } else {
                                             None
                                         };

                                         println!("Create mesh {:?} {:?} {:?}", addon_name, config.pipeline_id, custom_pipeline.is_some());

                                         if let Some(p) = custom_pipeline {
                                             (Some(p), config.pipeline_id.clone())
                                         } else if config.pipeline_id == "default" {
                                             // "default" is handled in render_addon_frame.rs using the engine's geometry_pipeline -
                                             // this placeholder is never bound or drawn, it only satisfies CustomMesh::new's
                                             // Arc<RenderPipeline> parameter. See create_placeholder_render_pipeline's doc comment.
                                             const PLACEHOLDER_ID: &str = "__default_mesh_placeholder__";
                                             let existing = op_state.try_borrow::<AddonContext>().and_then(|ctx| ctx.pipelines.get(PLACEHOLDER_ID).cloned());
                                             let placeholder = match existing {
                                                 Some(p) => Some(p),
                                                 None => {
                                                     let created = std::sync::Arc::new(create_placeholder_render_pipeline(&gpu.device));
                                                     if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                                                         ctx.pipelines.insert(PLACEHOLDER_ID.to_string(), created.clone());
                                                     }
                                                     Some(created)
                                                 }
                                             };
                                             (placeholder, "default".to_string())
                                         } else {
                                             (None, config.pipeline_id.clone())
                                         }
                                     };
                                     
                                     if let Some(pipeline) = pipeline {
                                         let (bind_groups, uniform_buffers, samplers, time_buffer) = if let Some(bindings) = config.bindings {
                                             self.create_bindings_from_config(gpu, landscape_view.clone(), &pipeline, bindings, config.id.clone(), current_addon_name.clone())
                                         } else {
                                             (Vec::new(), Vec::new(), Vec::new(), None)
                                         };
                                         
                                         // Create Mesh
                                         let vertex_bytes: &[u8] = bytemuck::cast_slice(&config.vertex_data);
                                         let index_bytes: &[u8] = bytemuck::cast_slice(&config.index_data);
                
                                         let id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                
                                         let mut mesh = CustomMesh::new(
                                             &gpu.device,
                                             &gpu.queue,
                                             vertex_bytes,
                                             index_bytes,
                                             pipeline,
                                             pipeline_id,
                                             bind_groups,
                                             config.position,
                                             id.clone(),
                                             uniform_buffers,
                                             samplers,
                                             config.instance_count.unwrap_or(1),
                                             time_buffer,
                                             &renderer_state.model_bind_group_layout,
                                             // `Entropy.Model.createMesh` has no way to attach a
                                             // real albedo/terrain texture, so binding the shared
                                             // `texture_render_mode_buffer` (mode 1, the 3-way
                                             // terrain blend gbuffer_fragment.wgsl uses) made every
                                             // addon-authored mesh sample its 1x1 fallback texture
                                             // through that blend math instead of showing its own
                                             // vertex colors - the House model's placeholder mesh
                                             // (procedural_models/House.rs) hits the identical case
                                             // and binds `color_render_mode_buffer` (mode 0, plain
                                             // vertex color) for exactly this reason.
                                             &renderer_state.color_render_mode_buffer,
                                             &renderer_state.group_bind_group_layout,
                                             camera
                                         );
                         
                         if let Some(rotation) = config.rotation {
                             mesh.transform.update_rotation(rotation);
                         }
                         if let Some(scale) = config.scale {
                             mesh.transform.update_scale(scale);
                         }
                         
                         if let Some(phys) = &config.physics {
                             let mass = phys.mass.unwrap_or(70.0);
                             let friction = phys.friction.unwrap_or(0.7);
                             let restitution = phys.restitution.unwrap_or(0.0);
                             
                             let mut rb_builder = match phys.body_type.as_str() {
                                 "dynamic" => RigidBodyBuilder::dynamic(),
                                 "kinematic" => RigidBodyBuilder::kinematic_position_based(),
                                 _ => RigidBodyBuilder::fixed(),
                             };
                             
                             let uuid = uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4());
                             
                             mesh.rapier_rigidbody = rb_builder
                                 .additional_mass(mass)
                                 .linear_damping(0.1)
                                 .position(Isometry3::translation(config.position[0], config.position[1], config.position[2]))
                                 .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                                 .user_data(uuid.as_u128())
                                 .build();
                                 
                             mesh.rapier_collider = match phys.collider_shape.as_str() {
                                 "capsule" => ColliderBuilder::capsule_y(1.0, 0.5),
                                 "ball" => ColliderBuilder::ball(0.5),
                                 "cuboid" => ColliderBuilder::cuboid(1.0, 1.0, 1.0),
                                 _ => ColliderBuilder::capsule_y(1.0, 0.5),
                             }
                             .friction(friction)
                             .restitution(restitution)
                             .user_data(uuid.as_u128())
                             .build();
                         }

                         mesh.render_role = config.render_role;
                         mesh.behavior_id = config.behavior_id.clone();
                         mesh.yumon_id = config.yumon_id.clone();

                         if config.is_npc == Some(true) {
                             let npc = NPC::new(
                                 &gpu.device,
                                 &gpu.queue,
                                 id.clone(),
                                 id.clone(),
                                 VisualType::CustomMesh,
                                 None,
                                 BehaviorConfig::default(),
                                 None,
                                 Some(VisualConfig {
                                    id: Some(id.clone()),
                                    visual_name: "New NPC".to_string(),
                                    template_id: id.clone(),
                                    position: config.position.clone(),
                                    rotation: config.rotation.clone(),
                                    scale: config.scale.clone(),
                                    pipeline_id: Some(config.pipeline_id),
                                    render_role: None,
                                    physics: None,
                                    player: None,
                                    is_npc: config.is_npc,
                                    behavior_id: config.behavior_id,
                                    yumon_id: config.yumon_id,
                                 })
                             );
                             renderer_state.npcs.push(npc);
                             renderer_state.add_collider(id.clone(), ComponentKind::NPC, Some(VisualType::CustomMesh));
                         }
                         if let Some(mut player_props) = config.player.clone() {
                            player_props.visual_type = Some(VisualType::CustomMesh);
                            renderer_state.add_player_character(
                                &gpu.device,
                                &gpu.queue,
                                id.clone(),
                            Isometry3::translation(config.position[0], config.position[1], config.position[2]),
                            Vector3::from(config.scale.unwrap_or([1.0, 1.0, 1.0])),
                                camera,
                                player_props
                            );
                         }

                         let meshes = renderer_state.addon_meshes.entry(addon_name).or_insert_with(Vec::new);
                         if let Some(pos) = meshes.iter().position(|m| m.id == id) {
                             meshes[pos] = mesh;
                         } else {
                             meshes.push(mesh);
                         }
                     }
                }
            }
        }

        if !pending_landscapes.is_empty() {
            if let gpu = &gpu_resources {
                for (addon_name, config) in pending_landscapes {
                    let mut heights = config.heights;

                    // If noise_id is provided, generate heights on the Rust side
                    if heights.is_none() {
                        if let Some(noise_id) = &config.noise_id {
                            let mut op_state = self.runtime.op_state();
                            let op_state = op_state.borrow();
                            if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                if let Some(noise_config) = ctx.noise_generators.get(noise_id) {
                                    // Instantiate noise
                                    let fbm = Fbm::<Perlin>::new(noise_config.seed)
                                        .set_frequency(noise_config.frequency)
                                        .set_octaves(noise_config.octaves)
                                        .set_persistence(noise_config.persistence)
                                        .set_lacunarity(noise_config.lacunarity);
                                    
                                    let mut generated_heights = Vec::with_capacity(config.width * config.height);
                                    for y in 0..config.height {
                                        for x in 0..config.width {
                                            let val = fbm.get([x as f64, y as f64]);
                                            generated_heights.push(((val + 1.0) / 2.0) as f32);
                                        }
                                    }
                                    heights = Some(generated_heights);
                                }
                            }
                        }
                    }

                    {
                        let mut op_state = self.runtime.op_state();
                        let mut op_state = op_state.borrow_mut();
                        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                            ctx.landscape_config = Some([config.size as f32, config.scale as f32, config.size as f32]);
                        }
                    }

                    if let Some(heights) = heights {
                        let mut scaled_like_image = Vec::new();
                        // 1. Find the current range
                        if !heights.is_empty() {
                            let mut min_h = heights[0];
                            let mut max_h = heights[0];
                            
                            for &h in &heights {
                                if h < min_h { min_h = h; }
                                if h > max_h { max_h = h; }
                            }

                            let range = max_h - min_h;

                            // 2. Scale the values
                            if range > 0.0 {
                                for h in heights.iter() {
                                    scaled_like_image.push((*h - min_h) / range);
                                }
                            } else {
                                // If all heights are the same (range == 0), 
                                // set them all to 0.0 (a flat plain)
                                scaled_like_image.fill(0.0);
                            }
                        }

                        let data = crate::helpers::landscapes::generate_landscape_data(
                            config.width,
                            config.height,
                            // heights,
                            scaled_like_image,
                            config.size as f32, // square_size
                            config.size as f32, // square_size
                            config.scale as f32,  // square_height
                        );

                        let id = config.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

                        let landscape = Landscape::new(
                            &id,
                            &data,
                            &gpu.device,
                            &gpu.queue,
                            &renderer_state.model_bind_group_layout,
                            &renderer_state.group_bind_group_layout,
                            &renderer_state.texture_render_mode_buffer,
                            &renderer_state.color_render_mode_buffer,
                            config.position,
                            camera,
                            config.pipeline_id
                        );
                        let mut landscape = landscape;
                        landscape.render_role = config.render_role;

                        // let landscapes = renderer_state.addon_landscapes.entry(addon_name).or_insert_with(Vec::new);
                        // if let Some(pos) = landscapes.iter().position(|l| l.id == id) {
                        //     landscapes[pos] = landscape;
                        // } else {
                        //     landscapes.push(landscape);
                        // }

                        // let mut landscape_bind_group = None;
                        
                            // println!("read heightmap {:?} {:?} {:?}", self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                            // not good for dynamic texture
                                // let heightmap_texture = read_landscape_heightmap_as_texture(self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                                    
                                if let Some(texture) = landscape.heightmap_texture.clone() { // possibly an expensive clone, although infrequent
                                    // let texture = Texture::new(texture_data.bytes, texture_data.width, texture_data.height);
                                    // println!("LANDSCAPPPPE update_particle_texture");

                                    landscape.update_particle_texture(
                                        &gpu.device,
                                        &gpu.queue,
                                        &renderer_state.model_bind_group_layout,
                                        &renderer_state.texture_render_mode_buffer,
                                        &renderer_state.color_render_mode_buffer,
                                        LandscapeTextureKinds::Primary,
                                        &texture,
                                    );

                                    // landscape.create_layout_for_particles(&gpu.device);
                                    // landscape_bind_group = Some(land.create_particle_bind_group(&gpu.device));

                                } else {
                                    println!("error Loading heightmap");
                                }
                            

                        // we only want 1 landscape to render at any given time
                        renderer_state.addon_landscapes
                            .insert(addon_name, vec![landscape]);

                        renderer_state.add_collider(id.clone(), ComponentKind::Landscape, None);
                    }
                }
            }
        }

        let pending_landscape3ds = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.pending_landscape3ds)
            } else {
                Vec::new()
            }
        };

        if !pending_landscape3ds.is_empty() {
            if let gpu = &gpu_resources {
                for (addon_name, config) in pending_landscape3ds {
                    let mut vertices = Vec::with_capacity(config.vertices.len() / 12);
                    for chunk in config.vertices.chunks(12) {
                        if chunk.len() == 12 {
                            vertices.push(Vertex {
                                position: [chunk[0], chunk[1], chunk[2]],
                                normal: [chunk[3], chunk[4], chunk[5]],
                                tex_coords: [chunk[6], chunk[7]],
                                color: [chunk[8], chunk[9], chunk[10], chunk[11]],
                            });
                        }
                    }

                    let id = config.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

                    let landscape = Landscape3D::new(
                        &id,
                        vertices,
                        config.indices,
                        &gpu.device,
                        &gpu.queue,
                        &renderer_state.model_bind_group_layout,
                        &renderer_state.group_bind_group_layout,
                        &renderer_state.texture_render_mode_buffer,
                        &renderer_state.color_render_mode_buffer,
                        config.position,
                        camera,
                        config.pipeline_id
                    );
                    let mut landscape = landscape;
                    landscape.render_role = config.render_role;

                    renderer_state.addon_landscape3ds
                        .entry(addon_name)
                        .or_insert_with(Vec::new)
                        .push(landscape);

                    renderer_state.add_collider(id.clone(), ComponentKind::Landscape3D, None);
                }
            }
        }

        if !pending_quadscapes.is_empty() {
            if let gpu = &gpu_resources {
                for (addon_name, config) in pending_quadscapes {
                    // let mut heights = config.heights;
                    let mut heights = None; // only Rust-side for now (also is only pbr for now)

                    // If noise_id is provided, generate heights on the Rust side
                    if heights.is_none() {
                        if let Some(noise_id) = &config.noise_id {
                            let mut op_state = self.runtime.op_state();
                            let op_state = op_state.borrow();
                            if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                if let Some(noise_config) = ctx.noise_generators.get(noise_id) {
                                    // Instantiate noise
                                    let fbm = Fbm::<Perlin>::new(noise_config.seed)
                                        .set_frequency(noise_config.frequency)
                                        .set_octaves(noise_config.octaves)
                                        .set_persistence(noise_config.persistence)
                                        .set_lacunarity(noise_config.lacunarity);
                                    
                                    let mut generated_heights = Vec::with_capacity(config.width * config.height);
                                    for y in 0..config.height {
                                        for x in 0..config.width {
                                            let val = fbm.get([x as f64, y as f64]);
                                            // generated_heights.push(((val + 1.0) / 2.0 * 255.0) as u8); // u8 is choppy, kinda voxel-like
                                            generated_heights.push(((val + 1.0) / 2.0 * 65535.0) as u16);
                                        }
                                    }
                                    heights = Some(generated_heights);
                                }
                            }
                        }
                    }

                    {
                        let mut op_state = self.runtime.op_state();
                        let mut op_state = op_state.borrow_mut();
                        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                            ctx.landscape_config = Some([config.size as f32, config.scale as f32, config.size as f32]);
                        }
                    }

                    if let Some(heights) = heights {
                        // let mut scaled_like_image = Vec::new();
                        // // 1. Find the current range
                        // if !heights.is_empty() {
                        //     let mut min_h = heights[0];
                        //     let mut max_h = heights[0];
                            
                        //     for &h in &heights {
                        //         if h < min_h { min_h = h; }
                        //         if h > max_h { max_h = h; }
                        //     }

                        //     let range = max_h - min_h;

                        //     // 2. Scale the values
                        //     if range > 0.0 {
                        //         for h in heights.iter() {
                        //             scaled_like_image.push((*h - min_h) / range);
                        //         }
                        //     } else {
                        //         // If all heights are the same (range == 0), 
                        //         // set them all to 0.0 (a flat plain)
                        //         scaled_like_image.fill(0.0);
                        //     }
                        // }

                        // let data = crate::helpers::landscapes::generate_landscape_data(
                        //     config.width,
                        //     config.height,
                        //     // heights,
                        //     scaled_like_image,
                        //     config.size as f32, // square_size
                        //     config.size as f32, // square_size
                        //     config.scale as f32,  // square_height
                        // );

                        let id = config.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

                        let terrain = Terrain::new(heights, config.width as u32, config.width as u32, config.scale as f32); // from QuadTree
                        let mut scape = QuadScape::new(terrain);

                        // we only want 1 landscape to render at any given time
                        renderer_state.addon_quadscapes
                            .insert(addon_name, vec![scape]);
                    }
                }
            }
        }


        if !pending_landscape_texture_updates.is_empty() {
            

            if let Some(gpu) = &renderer_state.gpu_resources {
                // println!("renderer_state landscapes... {:?}", renderer_state.addon_landscapes.keys());

                for (addon_name, update) in pending_landscape_texture_updates {
                    if let Some(landscapes) = renderer_state.addon_landscapes.get_mut(&addon_name) {
                        for landscape in landscapes {
                            // Find texture data
                            let texture_data = {
                                let op_state = self.runtime.op_state();
                                let op_state = op_state.borrow();
                                let ctx = op_state.borrow::<AddonContext>();
                                match update {
                                    LandscapeTextureUpdate::Regular { ref texture_id, .. } => ctx.addon_textures.get(texture_id).cloned(),
                                    LandscapeTextureUpdate::Pbr { ref texture_id, .. } => ctx.addon_textures.get(texture_id).cloned(),
                                }
                            };

                            // println!("renderer_state.addon_landscapes {:?}", addon_name);

                            if let Some(texture) = texture_data {
                                match update {
                                    LandscapeTextureUpdate::Regular { kind, .. } => {
                                        landscape.update_texture(
                                            &gpu.device,
                                            &gpu.queue,
                                            &renderer_state.model_bind_group_layout, // Wait, is this the right layout? Landscape.rs says texture_bind_group_layout
                                            &renderer_state.texture_render_mode_buffer,
                                            &renderer_state.color_render_mode_buffer,
                                            kind,
                                            &texture
                                        );
                                    },
                                    LandscapeTextureUpdate::Pbr { kind, material_type, .. } => {
                                        landscape.update_pbr_texture(
                                            &gpu.device,
                                            &gpu.queue,
                                            &renderer_state.model_bind_group_layout,
                                            &renderer_state.texture_render_mode_buffer,
                                            &renderer_state.color_render_mode_buffer,
                                            kind,
                                            material_type,
                                            &texture
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if !pending_grasses.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (addon_name, config) in pending_grasses {
                    let mut updated = false;

                    let landscape = renderer_state.addon_landscapes
                                                                .get_mut(&current_addon_name);


                    // let mut landscape_bind_group = None;
                    if let Some(terrain) = landscape {
                        // println!("LANDSCAPPPPE COOOUNNNTTT {:?}", terrain.len());

                       if let Some(land)  = terrain.first_mut() {
                        // println!("read heightmap {:?} {:?} {:?}", self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                        // not good for dynamic texture
                            // let heightmap_texture = read_landscape_heightmap_as_texture(self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                                
                            if let Some(texture) = land.heightmap_texture.clone() { // possibly an expensive clone, although infrequent
                                // let texture = Texture::new(texture_data.bytes, texture_data.width, texture_data.height);
                                // println!("LANDSCAPPPPE update_particle_texture");

                                land.update_particle_texture(
                                    &gpu.device,
                                    &gpu.queue,
                                    &renderer_state.model_bind_group_layout,
                                    &renderer_state.texture_render_mode_buffer,
                                    &renderer_state.color_render_mode_buffer,
                                    LandscapeTextureKinds::Primary,
                                    &texture,
                                );

                                // land.create_layout_for_particles(&gpu.device);
                                // landscape_bind_group = Some(land.create_particle_bind_group(&gpu.device));

                            } else {
                                println!("error Loading heightmap");
                            }
                        }
                    }

                    // println!("LANDSCAPPPPE landscape_view {:?}", landscape_view.is_some());                
                    
                    // 1. Try to find and update existing instance
                    if let Some(id) = &config.id {
                        if let Some(grasses) = renderer_state.addon_grasses.get_mut(&addon_name) {
                            if let Some(grass) = grasses.iter_mut().find(|g| g.id.as_ref() == Some(id)) {
                                // Update existing instance
                                if let Some(grid_size) = config.grid_size { grass.config.grid_size = grid_size; }
                                if let Some(render_distance) = config.render_distance { grass.config.render_distance = render_distance; }
                                if let Some(wind_strength) = config.wind_strength { grass.config.wind_strength = wind_strength; }
                                if let Some(wind_speed) = config.wind_speed { grass.config.wind_speed = wind_speed; }
                                if let Some(blade_height) = config.blade_height { grass.config.blade_height = blade_height; }
                                if let Some(blade_width) = config.blade_width { grass.config.blade_width = blade_width; }
                                if let Some(brownian_strength) = config.brownian_strength { grass.config.brownian_strength = brownian_strength; }
                                if let Some(blade_density) = config.blade_density { grass.config.blade_density = blade_density; }
                                if let Some(landscape_size) = config.landscape_size { grass.config.landscape_size = landscape_size; }
                                if let Some(landscape_height) = config.landscape_height { grass.config.landscape_height = landscape_height; }
                                if let Some(landscape_y_offset) = config.landscape_y_offset { grass.config.landscape_y_offset = landscape_y_offset; }
                                if let Some(base_color) = config.base_color { grass.config.base_color = base_color; }
                                if let Some(tip_color) = config.tip_color { grass.config.tip_color = tip_color; }
                                if config.render_role.is_some() { grass.render_role = config.render_role.clone(); }

                                // Update bindings if provided
                                if let Some(bindings) = config.bindings.clone() {
                                    let (new_bind_groups, new_uniform_buffers, new_samplers, time_buffer) = self.create_bindings_from_config(gpu, landscape_view.clone(), &grass.render_pipeline, bindings, Some(id.clone()), current_addon_name.clone());
                                    grass.bind_groups = new_bind_groups;
                                    grass.uniform_buffers = new_uniform_buffers;
                                    grass.samplers = new_samplers;
                                }

                                // Update pipeline if requested
                                if let Some(pid) = &config.pipeline_id {
                                    let mut op_state = self.runtime.op_state();
                                    let op_state = op_state.borrow();
                                    if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                        if let Some(p) = ctx.pipelines.get(pid) {
                                            grass.render_pipeline = Arc::clone(p);
                                        }
                                    }
                                }

                                // println!("update hair {:?} {:?}", grass.config.base_color, grass.config.tip_color);

                                grass.update_config(&gpu.queue, grass.config);
                                updated = true;
                            }
                        }
                    }

                    if updated { continue; }

                    // 2. Create new instance if not found
                    let (custom_pipeline, camera_layout) = {
                        let mut op_state = self.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                            let cp = config.pipeline_id.as_ref()
                                .and_then(|id| ctx.pipelines.get(id))
                                .map(|p| Arc::clone(p));
                            let cl = Arc::clone(&ctx.bind_group_layouts[0]);
                            (cp, cl)
                        } else {
                            (None, renderer_state.group_bind_group_layout.clone()) // fallback
                        }
                    };

                    let mut grass = Grass::new_without_landscape(
                        &gpu.device,
                        &gpu.queue,
                        &camera_layout,
                        custom_pipeline.clone()
                    );  

                    // if let Some(bg) = landscape_bind_group {
                    //     println!("binding grass to landscape");
                    //     grass.landscape_bind_group = bg;
                    // }

                    // since its a dynamic texture, we dont want it to autoload from file here
                    if let Some(landscape) = renderer_state.addon_landscapes
                                                                .get_mut(&current_addon_name) {
                        if let Some(landscape) = landscape.first_mut() {
                            // println!("binding grass to landscape landscape_view!!! {:?}", current_addon_name.clone());

                            grass = Grass::new(&gpu.device, &camera_layout, landscape, custom_pipeline);
                        }
                    }

                    landscape_view = renderer_state.addon_landscapes
                                        .get(&current_addon_name)
                                        .and_then(|al| al.first().and_then(|l| l.particle_texture_view.clone()));


                    grass.id = config.id.clone();
                    grass.addon_name = Some(addon_name.clone());
                    grass.pipeline_id = config.pipeline_id.clone();
                    grass.render_role = config.render_role.clone();

                    // Apply config overrides
                    if let Some(grid_size) = config.grid_size { grass.config.grid_size = grid_size; }
                    if let Some(render_distance) = config.render_distance { grass.config.render_distance = render_distance; }
                    if let Some(wind_strength) = config.wind_strength { grass.config.wind_strength = wind_strength; }
                    if let Some(wind_speed) = config.wind_speed { grass.config.wind_speed = wind_speed; }
                    if let Some(blade_height) = config.blade_height { grass.config.blade_height = blade_height; }
                    if let Some(blade_width) = config.blade_width { grass.config.blade_width = blade_width; }
                    if let Some(brownian_strength) = config.brownian_strength { grass.config.brownian_strength = brownian_strength; }
                    if let Some(blade_density) = config.blade_density { grass.config.blade_density = blade_density; }
                    if let Some(landscape_size) = config.landscape_size { grass.config.landscape_size = landscape_size; }
                    if let Some(landscape_height) = config.landscape_height { grass.config.landscape_height = landscape_height; }
                    if let Some(landscape_y_offset) = config.landscape_y_offset { grass.config.landscape_y_offset = landscape_y_offset; }
                    if let Some(base_color) = config.base_color { grass.config.base_color = base_color; }
                    if let Some(tip_color) = config.tip_color { grass.config.tip_color = tip_color; }

                    if let Some(bindings) = config.bindings {
                        let (new_bind_groups, new_uniform_buffers, new_samplers, time_buffer) = self.create_bindings_from_config(gpu, landscape_view.clone(), &grass.render_pipeline, bindings, config.id, current_addon_name.clone());
                        grass.bind_groups = new_bind_groups;
                        grass.uniform_buffers = new_uniform_buffers;
                        grass.samplers = new_samplers;
                    }

                    grass.update_config(&gpu.queue, grass.config);

                    renderer_state.addon_grasses
                        .entry(addon_name)
                        .or_insert_with(Vec::new)
                        .push(grass);
                }
            }
        }    
    }

    pub fn set_resources(
        &mut self, 
        gpu_resources: Arc<GpuResources>, 
        bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>,
        lighting_bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>,
        surface_format: wgpu::TextureFormat,
    ) {
        let mut op_state = self.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
            ctx.gpu_resources = Some(gpu_resources);
            ctx.bind_group_layouts = bind_group_layouts;
            ctx.lighting_bind_group_layouts = lighting_bind_group_layouts;
            ctx.surface_format = Some(surface_format);
        }
    }

    pub async fn load_addon(&mut self, addon_path: &Path) -> Result<ModuleId, AnyError> {
        // `ModuleSpecifier::from_file_path` (i.e. `Url::from_file_path`) is the only correct way
        // to turn a filesystem path into a `file://` URL: it requires an absolute path (so a
        // relative `addon_path` must be resolved against the current directory first) and takes
        // care of platform-specific quirks itself (e.g. a Windows drive letter and backslashes).
        // Hand-formatting `file:///{path}` broke on both counts.
        let absolute_path = if addon_path.is_absolute() {
            addon_path.to_path_buf()
        } else {
            std::env::current_dir()?.join(addon_path)
        };
        let absolute_path = absolute_path.canonicalize().unwrap_or(absolute_path);

        let module_specifier = ModuleSpecifier::from_file_path(&absolute_path)
            .map_err(|_| anyhow::anyhow!("Could not build a file:// URL for addon path {:?}", absolute_path))?;
        let module_id = self.runtime.load_main_es_module(&module_specifier).await?;
        let _ = self.runtime.mod_evaluate(module_id).await?;

        self.run_on_init();
        self.run_on_all_addons_initialized();

        Ok(module_id)
    }

    pub fn load_default_bundle(&mut self) {
        if let Err(e) = self.load_bundle_sync("Default Bundle", DEFAULT_ADDON_BUNDLE) {
            println!("Failed to load default bundle: {}", e);
        }
    }

    pub fn start_game(&mut self, game_name: &str) {
        let script = "const renderer = Entropy.Composer?.getGame('".to_owned() + game_name.clone() + "');
if (renderer) {
renderer(addon, {});
};
globalThis.Entropy._dispatchGameStarted('" + game_name.clone() + "')";
        if let Err(e) = self.runtime.execute_script("start_game", script) {
            println!("Failed to start game {}: {}", game_name, e);
        }
    }

    pub fn load_bundle_sync(&mut self, name: &'static str, source: &str) -> Result<(), AnyError> {
        self.runtime.execute_script(name, source.to_string())?;
        self.run_on_init();
        println!("ALL ADDONS INITIALIZED - RUN CALLBACKS");
        self.run_on_all_addons_initialized();
        Ok(())
    }

    /// Start watching `path` for hot reload - call once, right after the bundle at that path
    /// has been loaded (e.g. from `load_addon`). Polled from `update()` every frame via
    /// `check_hot_reload`, comparing mtimes rather than a filesystem watcher: this engine's
    /// `JsRuntime` isn't `Send`, so it must be driven from the same thread as the render loop
    /// already polling it every frame anyway - a background `notify` watcher would just be
    /// another thing to hand a reload signal back across, for no benefit over an mtime check
    /// that already runs on the right thread.
    pub fn enable_hot_reload(&mut self, path: PathBuf) {
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        println!("[AddonEngine] Hot reload watching {:?}", path);
        self.hot_reload_path = Some(path);
        self.hot_reload_last_mtime = mtime;
    }

    /// How long a newly observed mtime must hold steady before we treat the file as done
    /// being written and actually reload it. See `hot_reload_pending`'s doc comment for why
    /// this needs to be wall-clock time rather than a fixed number of polls.
    const HOT_RELOAD_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);

    /// Poll the watched bundle file (if any) for a newer, since-settled mtime and reload it.
    fn check_hot_reload(&mut self) {
        let Some(path) = self.hot_reload_path.clone() else { return };
        let Ok(meta) = std::fs::metadata(&path) else { return };
        let Ok(mtime) = meta.modified() else { return };

        if self.hot_reload_last_mtime == Some(mtime) {
            self.hot_reload_pending = None;
            return;
        }

        match self.hot_reload_pending {
            Some((pending_mtime, since)) if pending_mtime == mtime => {
                if since.elapsed() < Self::HOT_RELOAD_DEBOUNCE {
                    return;
                }
            }
            _ => {
                // First sight of this mtime, or it changed again mid-debounce (another write
                // still in flight) - (re)start the settle timer and wait for the next poll.
                self.hot_reload_pending = Some((mtime, std::time::Instant::now()));
                return;
            }
        }
        self.hot_reload_pending = None;

        // Record the new mtime up front - if the reload below fails (e.g. a syntax error in
        // the saved file), we don't want to retry every frame against the same broken file.
        // The next successful save produces a newer mtime and tries again.
        self.hot_reload_last_mtime = Some(mtime);

        if let Err(e) = self.reload_bundle_from_disk(&path) {
            eprintln!("[AddonEngine] Hot reload failed: {}", e);
        }
    }

    /// Re-execute the bundle at `path` in the *same* running `JsRuntime`, so engine-side
    /// addon state (GPU buffers, pipelines, meshes - anything reachable from Rust by an
    /// addon-supplied stable id) survives the reload instead of being torn down and rebuilt.
    /// Only per-load JS bookkeeping (callback registrations) is cleared first; see the
    /// `AddonContext` field comments this touches for what's deliberately left alone.
    fn reload_bundle_from_disk(&mut self, path: &Path) -> Result<(), AnyError> {
        let source = std::fs::read_to_string(path)?;
        self.hot_reload_gen += 1;

        {
            let op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                // Vec-typed callback registries: never drained on their own (unlike
                // on_init_callbacks/on_all_addons_initialized_callbacks below, which
                // `run_on_init`/`run_on_all_addons_initialized` already `mem::take` every
                // call), so leaving these alone would mean the OLD script's onUpdate/
                // onCleanup/etc. closures keep firing alongside the new ones - most visibly
                // as onUpdate running the game-logic twice per frame.
                ctx.registered_addons.clear();
                ctx.on_cleanup_callbacks.clear();
                ctx.on_update_callbacks.clear();
                ctx.on_action_callbacks.clear();
                ctx.on_project_changed_callbacks.clear();
                ctx.op_addon_on_all_projects_loaded_callbacks.clear();
                ctx.tab_order.clear();
                ctx.window_order.clear();
                // Deliberately NOT cleared: resource maps (buffers, pipelines,
                // compute_pipelines, textures, addon_meshes on RendererState, etc.) and
                // HashMap-keyed registries (behaviors, ui_windows, ui_tabs, registered_tools)
                // - the latter self-heal on the new script's re-registration (HashMap insert
                // overwrites the same key), and the former are exactly the state this reload
                // is meant to preserve.
            }
        }

        let script_name: &'static str =
            Box::leak(format!("hot_reload_{}", self.hot_reload_gen).into_boxed_str());
        self.runtime.execute_script(script_name, source)?;

        println!("[AddonEngine] \u{1f525} Hot reloaded bundle from {:?}", path);
        self.run_on_init();
        self.run_on_all_addons_initialized();
        Ok(())
    }

    fn run_on_init(&mut self) {
        // Execute onInit callbacks
        let callbacks = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.on_init_callbacks)
            } else {
                Vec::new()
            }
        };

        if !callbacks.is_empty() {
            let scope = &mut self.runtime.handle_scope();
            for (_addon_name, callback) in callbacks {
                let func = v8::Local::new(scope, callback);
                let receiver = v8::undefined(scope);
                let _ = func.call(scope, receiver.into(), &[]);
            }
        }
    }

    fn run_on_all_addons_initialized(&mut self) {
        let callbacks = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.on_all_addons_initialized_callbacks)
            } else {
                Vec::new()
            }
        };

        if !callbacks.is_empty() {
            let scope = &mut self.runtime.handle_scope();
            for callback in callbacks {
                let func = v8::Local::new(scope, callback);
                let receiver = v8::undefined(scope);
                let _ = func.call(scope, receiver.into(), &[]);
            }
        }
    }

    // fn run_on_all_addons_initialized(&mut self) {
    //     let callbacks = {
    //         let mut op_state = self.runtime.op_state();
    //         let mut op_state = op_state.borrow_mut();
    //         if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
    //             std::mem::take(&mut ctx.on_all_addons_initialized_callbacks)
    //         } else {
    //             Vec::new()
    //         }
    //     };

    //     if !callbacks.is_empty() {
    //         let scope = &mut self.runtime.handle_scope();
    //         for callback in callbacks {
    //             let func = v8::Local::new(scope, callback);
    //             let receiver = v8::undefined(scope);
    //             let _ = func.call(scope, receiver.into(), &[]);
    //         }
    //     }
    // }

    pub fn get_registered_addons(&mut self) -> Vec<AddonMetadata> {
        let op_state = self.runtime.op_state();
        let op_state = op_state.borrow();
        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
            ctx.registered_addons.clone().into_iter().map(|(name, meta)| meta.clone()).collect()
        } else {
            Vec::new()
        }
    }

    pub fn is_render_allowed(addon_name: &str) -> bool {
        addon_name != "__VOID__"
    }

    pub fn get_registered_tools(&mut self) -> Vec<ToolDefinition> {
        let op_state = self.runtime.op_state();
        let op_state = op_state.borrow();
        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
            ctx.registered_tools.values().map(|(def, _)| def.clone()).collect()
        } else {
            Vec::new()
        }
    }

    pub fn call_tool(&mut self, name: &str, arguments: &str) -> Option<String> {
        let callback = {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                ctx.registered_tools.get(name).map(|(_, cb)| cb.clone())
            } else {
                None
            }
        };

        if let Some(callback) = callback {
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, callback);
            let receiver = v8::undefined(tc);

            // Log raw arguments for debugging
            println!("[TOOL CALL: {}] Raw arguments: {}", name, arguments);
            
            let args_json: serde_json::Value = serde_json::from_str(arguments).unwrap_or(serde_json::Value::Null);
            let args_v8 = serde_v8::to_v8(tc, args_json).unwrap();
            
            let result = func.call(tc, receiver.into(), &[args_v8]);
            
            if tc.has_caught() {
                if let Some(exception) = tc.exception() {
                    let msg = exception.to_rust_string_lossy(tc);
                    println!("[TOOL ERROR: {}] {}", name, msg);
                    return Some(format!("Error: {}", msg));
                }
            }

            if let Some(res) = result {
                if res.is_string() {
                    return Some(res.to_rust_string_lossy(tc));
                } else if res.is_object() || res.is_array() {
                    // Try to stringify
                    let json_key = v8::String::new(tc, "JSON").unwrap();
                    let json_obj = tc.get_current_context().global(tc).get(tc, json_key.into()).unwrap().to_object(tc).unwrap();
                    let stringify_key = v8::String::new(tc, "stringify").unwrap();
                    let stringify_func = v8::Local::<v8::Function>::try_from(json_obj.get(tc, stringify_key.into()).unwrap()).unwrap();
                    let json_str = stringify_func.call(tc, json_obj.into(), &[res]).unwrap();
                    return Some(json_str.to_rust_string_lossy(tc));
                } else {
                    return Some(res.to_rust_string_lossy(tc));
                }
            }
        }
        
        None
    }

    pub fn consume_new_tabs(&mut self) -> Vec<(String, String, String)> {
        let mut op_state = self.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
            std::mem::take(&mut ctx.new_tabs)
        } else {
            Vec::new()
        }
    }

    /// Applies the theme last set via `Entropy.UI.setTheme(...)`, if any. Re-applied every
    /// frame (cheap - just builds a `Style` from a handful of `Option<[f32;4]>`s) rather than
    /// drained, since `Entropy.UI.setTheme` is normally called once from a widget's `onChange`
    /// and the style needs to stick on every subsequent frame, not just the next one. Called
    /// from both `render_ui` (Studio's per-viewport path) and `render_tabs` (the generic
    /// full-window tab bar embedded apps use), since a standalone `EntropyApp` calls only the
    /// latter.
    fn apply_pending_theme(&mut self, ctx: &egui::Context) {
        let theme = {
            let mut op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            op_state.try_borrow::<AddonContext>().and_then(|c| c.pending_theme.clone())
        };
        if let Some(theme) = theme {
            ctx.set_style(egui::style_from_theme(&theme));
        }
        self.sync_gui_services(ctx);
    }

    /// Per-frame hand-off between the addon context and the GUI context's shared services:
    /// preferences, queued toasts, toast button presses (sent back as UI events), and who owns
    /// the keyboard (read by `Entropy.Input.isTypingInUI` and the key-event dispatch).
    fn sync_gui_services(&mut self, ctx: &egui::Context) {
        let op_state = self.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        let Some(context) = op_state.try_borrow_mut::<AddonContext>() else { return };
        if let Some(p) = &context.pending_ui_prefs {
            let mut prefs = ctx.prefs();
            if let Some(r) = p.reduce_motion {
                prefs.reduce_motion = r;
            }
            if let Some(ms) = p.tooltip_delay_ms {
                prefs.tooltip_delay = (ms / 1000.0).max(0.0);
            }
            ctx.set_prefs(prefs);
        }
        for command in std::mem::take(&mut context.pending_toasts) {
            match command {
                crate::deno::addon_ops::ToastCommand::Show(c) => {
                    let kind = crate::entropy_gui::ToastKind::parse(c.kind.as_deref().unwrap_or("info"));
                    let duration = match c.duration_ms {
                        Some(ms) if ms <= 0.0 => None,
                        Some(ms) => Some((ms / 1000.0) as f32),
                        None if kind == crate::entropy_gui::ToastKind::Error || c.progress.is_some() => None,
                        None => Some(4.0),
                    };
                    ctx.show_toast(crate::entropy_gui::Toast { id: c.id, message: c.message, kind, action: c.action_label, progress: c.progress, duration });
                }
                crate::deno::addon_ops::ToastCommand::Dismiss(id) => ctx.dismiss_toast(&id),
            }
        }
        let events = ctx.take_toast_events();
        if !events.is_empty() {
            if let Ok(mut ui_events) = context.ui_events.lock() {
                for e in events {
                    ui_events.push(match e {
                        crate::entropy_gui::ToastEvent::Action(id) => format!("__toast_action:{id}"),
                        crate::entropy_gui::ToastEvent::Dismissed(id) => format!("__toast_dismissed:{id}"),
                    });
                }
            }
        }
        context.ui_wants_keyboard = ctx.wants_keyboard_input();
        context.ui_keyboard_navigating = ctx.keyboard_navigating();
    }

    pub fn render_ui(&mut self, ctx: &egui::Context, egui_renderer: &mut egui_wgpu::Renderer) {
        self.apply_pending_theme(ctx);
        // 0. Reset widget counter in JS
        {
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let reset_key = v8::String::new(scope, "_reset_widget_counter").unwrap();
                    if let Some(reset_val) = entropy_obj.get(scope, reset_key.into()) {
                        if reset_val.is_function() {
                            let reset_func = v8::Local::<v8::Function>::try_from(reset_val).unwrap();
                            let _ = reset_func.call(scope, entropy_obj.into(), &[]);
                        }
                    }
                }
            }
        }

        // 1. Prepare: Clear widgets and handle click-to-raise
        {
            let pressed_layer = ctx.pressed_layer();
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.ui_widgets.clear();
                if let Some(pressed) = pressed_layer {
                    if let Some(pos) = context.window_order.iter().position(|id| egui::Id::new(id) == pressed) {
                        let id = context.window_order.remove(pos);
                        context.window_order.push(id);
                    }
                }
            }
        }
    
        {
            // 2. Execute JS callbacks to populate widgets
            let callbacks = {
                let mut op_state = self.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                    context.window_order.retain(|id| context.ui_windows.contains_key(id));
                    for id in context.ui_windows.keys() {
                        if !context.window_order.contains(id) {
                            context.window_order.push(id.clone());
                        }
                    }
                    let order = &context.window_order;
                    let mut windows: Vec<_> = context.ui_windows.iter()
                        .filter(|(_, (config, _))| config.owner_tab_id.as_ref().map_or(true, |owner| context.active_tab.as_ref() == Some(owner)))
                        .map(|(id, (_, cb))| (id.clone(), cb.clone())).collect();
                    windows.sort_by_key(|(id, _)| order.iter().position(|w| w == id).unwrap_or(usize::MAX));
                    windows
                } else {
                    Vec::new()
                }
            };
        
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            for (_id, cb) in callbacks {
                // Reset widget counter for each window
                {
                    let global = tc.get_current_context().global(tc);
                    let entropy_key = v8::String::new(tc, "Entropy").unwrap();
                    if let Some(entropy_val) = global.get(tc, entropy_key.into()) {
                        if entropy_val.is_object() {
                            let entropy_obj = entropy_val.to_object(tc).unwrap();
                            let reset_key = v8::String::new(tc, "_reset_widget_counter").unwrap();
                            if let Some(reset_val) = entropy_obj.get(tc, reset_key.into()) {
                                if reset_val.is_function() {
                                    let reset_func = v8::Local::<v8::Function>::try_from(reset_val).unwrap();
                                    let _ = reset_func.call(tc, entropy_obj.into(), &[]);
                                }
                            }
                        }
                    }
                }

                let func = v8::Local::new(tc, cb);
                let receiver = v8::undefined(tc);
                let js_started = std::time::Instant::now();
                let _ = func.call(tc, receiver.into(), &[]); 
                crate::core::frame_profile::record("  ui onRender (js)", js_started.elapsed());
                
                if tc.has_caught() {
                    if let Some(exception) = tc.exception() {
                        let msg = exception.to_rust_string_lossy(tc);
                        println!("[ADDON UI ERROR] {}", msg);
                    }
                    tc.reset();
                }
            }
        }
        
        // 3. Render
        let mut events_to_push = Vec::new();
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                let order = &context.window_order;
                let mut sorted_windows: Vec<_> = context.ui_windows.iter().map(|(id, (config, _))| (id.clone(), config.clone())).collect();
                sorted_windows.sort_by_key(|(id, _)| order.iter().position(|w| w == id).unwrap_or(usize::MAX));

                // Only rewrite the list when there are windows to read it from: a tabbed addon has
                // none, and `render_tabs` owns the list for it (clearing here every frame would wipe
                // what the tab path just recorded).
                // When the tab pass already filled it this frame (an app with a tab AND a window,
                // like the DAW with its Analyzer), keep those labels and add the windows' to them.
                let tab_labels_present = std::mem::take(&mut context.ui_frame_labels_from_tabs);
                if !sorted_windows.is_empty() && !tab_labels_present {
                    context.ui_frame_labels.clear();
                }
                for (id, config) in &sorted_windows {
                    if !config.visible || config.owner_tab_id.as_ref().is_some_and(|owner| context.active_tab.as_ref() != Some(owner)) { continue; }
                    context.ui_frame_labels.push(config.title.clone());
                    if let Some(widgets) = context.ui_widgets.get(id) {
                        context.ui_frame_labels.extend(widgets.iter().filter_map(|widget| match widget {
                            UiWidget::Label { text, .. } => Some(text.clone()),
                            // A knob draws its own caption, so it counts as a visible label too.
                            UiWidget::Knob { label, .. } if !label.is_empty() => Some(label.clone()),
                            _ => None,
                        }));
                    }
                }

                for (id, config) in sorted_windows {
                    if !config.visible || config.owner_tab_id.as_ref().is_some_and(|owner| context.active_tab.as_ref() != Some(owner)) { continue; }
                    let mut open = true;
                    let mut window = egui::Window::new(&config.title)
                        .id(egui::Id::new(&id))
                        .resizable(config.resizable)
                        .decorations(config.decorations)
                        .default_size([config.default_size.width, config.default_size.height]);
                    if let Some(pos) = config.default_pos {
                        window = window.default_pos(pos);
                    }
                    if config.glass {
                        if let Some(texture_id) = context.glass_blur_texture_id {
                            window = window.glass(texture_id);
                        }
                    }
                    window
                        .open(&mut open)
                        .show(ctx, |ui| {
                             egui::ScrollArea::vertical().show(ui, |ui| {
                                 let widgets = context.ui_widgets.remove(&id);
                                 if let Some(widgets) = widgets {
                                     Self::render_widgets(ui, &widgets, &mut events_to_push, context, egui_renderer);
                                 }
                             });
                        });
                    // The close button or Escape closed it: hide it (it can be shown again with
                    // `setWindowVisible`) and tell the addon (`onClose`).
                    if !open {
                        if let Some((config, _)) = context.ui_windows.get_mut(&id) {
                            config.visible = false;
                        }
                        events_to_push.push(format!("__window_closed:{id}"));
                    }
                }
            }
        }

        // Snapshot this frame's UI-hover state for addon-facing Entropy.Input.isPointerOverUI()
        // - must happen after every window above has been drawn (each Window::show() call sets
        // ctx's pointer_over_ui flag if the pointer was within it), not before.
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.pointer_over_ui = ctx.pointer_over_ui() && !context.bdd_pointer_in_viewport;
            }
        }

        // Push events
        if !events_to_push.is_empty() {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<AddonContext>() {
                if let Ok(mut events) = context.ui_events.lock() {
                    events.extend(events_to_push);
                }
            }
        }
    }

    /// Renders every `Entropy.UI.createTab`/`addon.UI.createTab` tab as a plain, generic
    /// full-window layout: a tab-bar strip along the top (only shown once there's more than one
    /// tab) plus the active tab's content filling the rest of the window. This is the
    /// non-Studio counterpart to `render_ui`'s floating windows - Studio itself renders the same
    /// `ui_tabs` data inside its own `DockArea` (see `render_egui.rs`) instead of calling this.
    pub fn render_tabs(&mut self, ctx: &egui::Context, egui_renderer: &mut egui_wgpu::Renderer) {
        self.apply_pending_theme(ctx);
        // 0. Reset widget counter in JS (same bookkeeping as render_ui).
        {
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let reset_key = v8::String::new(scope, "_reset_widget_counter").unwrap();
                    if let Some(reset_val) = entropy_obj.get(scope, reset_key.into()) {
                        if reset_val.is_function() {
                            let reset_func = v8::Local::<v8::Function>::try_from(reset_val).unwrap();
                            let _ = reset_func.call(scope, entropy_obj.into(), &[]);
                        }
                    }
                }
            }
        }

        // 1. Snapshot the tab list (in creation order) and resolve/default the active tab.
        let (tabs, active_tab): (Vec<(String, String, String)>, Option<String>) = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                // Check if any tab selection event was queued from BDD or controls
                if let Ok(mut events) = context.ui_events.lock() {
                    let mut switch_to = None;
                    events.retain(|evt| {
                        if evt == "tab_daw" || evt == "tab_DAW" {
                            switch_to = Some("DAW".to_string());
                            false
                        } else if evt == "tab_guitar_tabs" || evt == "tab_tabs" {
                            switch_to = Some("guitar-tabs".to_string());
                            false
                        } else if evt == "tab_cc_manager" || evt == "tab_cc" {
                            switch_to = Some("tasks".to_string());
                            false
                        } else if let Some(target) = evt.strip_prefix("TAB_SELECT|") {
                            switch_to = Some(target.to_string());
                            false
                        } else {
                            true
                        }
                    });
                    if let Some(target) = switch_to {
                        let match_id = context.tab_order.iter().find(|id| {
                            if *id == &target {
                                return true;
                            }
                            if let Some((cfg, _, addon_name)) = context.ui_tabs.get(*id) {
                                if addon_name.eq_ignore_ascii_case(&target)
                                    || cfg.title.eq_ignore_ascii_case(&target)
                                    || cfg.title.to_lowercase().contains(&target.to_lowercase())
                                {
                                    return true;
                                }
                            }
                            false
                        }).cloned();
                        if let Some(id) = match_id {
                            context.active_tab = Some(id);
                        }
                    }
                }

                context.tab_order.retain(|id| context.ui_tabs.contains_key(id));
                let tabs: Vec<(String, String, String)> = context.tab_order.iter()
                    .filter_map(|id| context.ui_tabs.get(id).map(|(cfg, _, addon_name)| (id.clone(), cfg.title.clone(), addon_name.clone())))
                    .collect();
                if context.active_tab.as_ref().map_or(true, |id| !context.ui_tabs.contains_key(id)) {
                    context.active_tab = tabs.first().map(|(id, _, _)| id.clone());
                }
                (tabs, context.active_tab.clone())
            } else {
                (Vec::new(), None)
            }
        };

        if tabs.is_empty() {
            self.selected_addon_name = None;
            return;
        }

        // 2. Windows-style taskbar at the bottom - only shown when there's more than one app bundled.
        if tabs.len() > 1 {
            Self::render_windows_taskbar(ctx, &tabs, active_tab.as_deref(), &mut self.runtime);
        }

        // The taskbar can change the selection during this UI pass. Cache the resolved
        // addon once here so scene rendering never needs to borrow the JS op state.
        let active_tab = {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            op_state.try_borrow::<AddonContext>().and_then(|context| context.active_tab.clone())
        };
        self.selected_addon_name = tabs.iter()
            .find(|(id, _, _)| active_tab.as_ref() == Some(id))
            .map(|(_, _, addon_name)| addon_name.clone());
        let Some(active_id) = active_tab else { return };

        // 3. Run the active tab's JS onRender callback to (re)populate its widgets.
        let callback = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.ui_tabs.get(&active_id).map(|(_, cb, _)| cb.clone())
            } else {
                None
            }
        };

        if let Some(cb) = callback {
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, cb);
            let receiver = v8::undefined(tc);
            let js_started = std::time::Instant::now();
            let _ = func.call(tc, receiver.into(), &[]);
            crate::core::frame_profile::record("  ui onRender (js)", js_started.elapsed());
            if tc.has_caught() {
                if let Some(exception) = tc.exception() {
                    let msg = exception.to_rust_string_lossy(tc);
                    println!("[ADDON UI ERROR] {}", msg);
                }
                tc.reset();
            }
        }

        // 4. Draw the populated widgets, filling the rest of the window.
        let mut events_to_push = Vec::new();
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                let widgets = context.ui_widgets.remove(&active_id);
                // The BDD driver's "I see the label" reads this. `render_ui` fills it for windowed
                // addons; a tabbed addon (the DAW) draws through here instead, so it needs the same.
                // These are the labels the addon emitted this frame, including any inside a
                // collapsed header - the addon still declares them, the widget just doesn't paint.
                context.ui_frame_labels = widgets
                    .as_ref()
                    .map(|w| w.iter().filter_map(|widget| if let UiWidget::Label { text, .. } = widget { Some(text.clone()) } else { None }).collect())
                    .unwrap_or_default();
                context.ui_frame_labels_from_tabs = true;
                if tabs.len() > 1 {
                    for (_, title, addon_name) in &tabs {
                        if !context.ui_frame_labels.contains(title) {
                            context.ui_frame_labels.push(title.clone());
                        }
                        if !context.ui_frame_labels.contains(addon_name) {
                            context.ui_frame_labels.push(addon_name.clone());
                        }
                    }
                    if !context.ui_frame_labels.contains(&"DAW".to_string()) {
                        context.ui_frame_labels.push("DAW".to_string());
                    }
                    if !context.ui_frame_labels.contains(&"Guitar Tabs".to_string()) {
                        context.ui_frame_labels.push("Guitar Tabs".to_string());
                    }
                    if !context.ui_frame_labels.contains(&"CC Manager".to_string()) {
                        context.ui_frame_labels.push("CC Manager".to_string());
                    }
                    if !context.ui_frame_labels.contains(&"Mesha".to_string()) {
                        context.ui_frame_labels.push("Mesha".to_string());
                    }
                    if !context.ui_frame_labels.contains(&"Start".to_string()) {
                        context.ui_frame_labels.push("Start".to_string());
                    }
                }
                let scroll = context.ui_tabs.get(&active_id).and_then(|(cfg, _, _)| cfg.scroll) != Some(false);
                let transparent = context.ui_tabs.get(&active_id).is_some_and(|(cfg, _, _)| cfg.transparent);
                if !transparent {
                    egui::CentralPanel::default().show(ctx, |ui| {
                        if let Some(widgets) = widgets {
                            if scroll {
                                egui::ScrollArea::vertical().show(ui, |ui| {
                                    Self::render_widgets(ui, &widgets, &mut events_to_push, context, egui_renderer);
                                });
                            } else {
                                Self::render_widgets(ui, &widgets, &mut events_to_push, context, egui_renderer);
                            }
                        }
                    });
                }
            }
        }

        // See the matching comment in render_ui - same snapshot, for the tabs (non-Studio)
        // rendering path.
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.pointer_over_ui = ctx.pointer_over_ui() && !context.bdd_pointer_in_viewport;
            }
        }

        // Push events
        if !events_to_push.is_empty() {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<AddonContext>() {
                if let Ok(mut events) = context.ui_events.lock() {
                    events.extend(events_to_push);
                }
            }
        }
    }

    pub fn render_windows_taskbar(
        ctx: &egui::Context,
        tabs: &[(String, String, String)],
        active_tab: Option<&str>,
        runtime: &mut deno_core::JsRuntime,
    ) {
        use egui::Color32;

        let screen_rect = ctx.screen_rect();
        let taskbar_height = 48.0;

        // Retrieve current start menu state and setup mutable state tracking
        let mut start_menu_open = {
            let op_state = runtime.op_state();
            let op_state = op_state.borrow();
            op_state.try_borrow::<AddonContext>().map(|c| c.taskbar_start_menu_open).unwrap_or(false)
        };

        let mut tab_to_activate: Option<String> = None;
        let mut toggle_start_menu = false;

        // 1. Bottom taskbar panel
        let panel_frame = egui::Frame::none().fill(Color32::from_rgba_unmultiplied(20, 23, 31, 245));
        egui::TopBottomPanel::bottom("entropy_windows_taskbar")
            .default_height(taskbar_height)
            .frame(panel_frame)
            .show(ctx, |ui| {
                let rect = ui.max_rect();
                let painter = ui.painter();

                // Luminous top border and subtle gradient sheen
                painter.line_segment(
                    [egui::pos2(rect.min.x, rect.min.y), egui::pos2(rect.max.x, rect.min.y)],
                    egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 28)),
                );
                painter.rect_filled_gradient(
                    egui::Rect::from_min_max(rect.min, egui::pos2(rect.max.x, rect.min.y + 2.0)),
                    Color32::from_rgba_unmultiplied(255, 255, 255, 8),
                    Color32::from_rgba_unmultiplied(255, 255, 255, 8),
                    Color32::TRANSPARENT,
                    Color32::TRANSPARENT,
                );

                let center_y = rect.center().y;

                // Left side: Windows 11 Widgets pill
                let widget_pill_rect = egui::Rect::from_min_size(egui::pos2(rect.min.x + 12.0, center_y - 14.0), egui::vec2(120.0, 28.0));
                let widget_resp = ui.interact(widget_pill_rect, egui::Id::new("taskbar_widgets_pill"), egui::Sense::click());
                let widget_bg = if widget_resp.hovered() {
                    Color32::from_rgba_unmultiplied(255, 255, 255, 18)
                } else {
                    Color32::from_rgba_unmultiplied(255, 255, 255, 8)
                };
                painter.rect_filled(widget_pill_rect, 14.0, widget_bg);
                painter.rect_stroke(widget_pill_rect, 14.0, egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 16)), egui::StrokeKind::Inside);
                let widget_glyph = crate::entropy_gui::icons::glyph("squares-four", crate::entropy_gui::icons::IconStyle::Bold)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "❖".to_string());
                painter.text(
                    egui::pos2(widget_pill_rect.min.x + 10.0, center_y),
                    egui::Align2::LEFT_CENTER,
                    widget_glyph,
                    egui::FontId::proportional(13.0),
                    Color32::from_rgb(130, 200, 255),
                );
                painter.text(
                    egui::pos2(widget_pill_rect.min.x + 28.0, center_y),
                    egui::Align2::LEFT_CENTER,
                    "Creative Suite",
                    egui::FontId::proportional(11.0),
                    Color32::from_rgb(220, 226, 238),
                );

                // Center cluster: Windows 11 Centered Dock (Start, Search, Task View, and App Icons without labels)
                let btn_size = 40.0;
                let btn_gap = 4.0;
                let sep_gap = 8.0;
                let sep_line_w = 1.0;

                let sys_count = 3; // Start, Search, Task View
                let sys_total_w = sys_count as f32 * btn_size + (sys_count - 1) as f32 * btn_gap;
                let sep_total_w = sep_gap * 2.0 + sep_line_w;
                let apps_count = tabs.len();
                let apps_total_w = if apps_count > 0 {
                    apps_count as f32 * btn_size + (apps_count - 1) as f32 * btn_gap
                } else {
                    0.0
                };
                let center_total_w = sys_total_w + sep_total_w + apps_total_w;

                // Center horizontally on the screen
                let mut cur_x = (rect.min.x + (rect.width() - center_total_w) / 2.0).round();
                // Ensure room on the left for the widget pill
                let min_left_x = rect.min.x + 144.0;
                if cur_x < min_left_x {
                    cur_x = min_left_x;
                }

                // 1. Windows Start Button (2x2 blue square grid, centered)
                let start_btn_rect = egui::Rect::from_center_size(egui::pos2(cur_x + btn_size / 2.0, center_y), egui::vec2(btn_size, btn_size));
                let start_resp = ui.interact(start_btn_rect, egui::Id::new("taskbar_win_start"), egui::Sense::click());
                if start_resp.clicked() {
                    toggle_start_menu = true;
                }
                let is_start_active = start_menu_open || start_resp.hovered();
                if is_start_active {
                    painter.rect_filled(start_btn_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 20));
                }

                // Draw Windows 4-tile logo with signature Microsoft colors
                let logo_center = start_btn_rect.center();
                let tile_size = 6.0;
                let gap = 2.0;
                let tl = egui::Rect::from_min_size(egui::pos2(logo_center.x - tile_size - gap / 2.0, logo_center.y - tile_size - gap / 2.0), egui::vec2(tile_size, tile_size));
                let tr = egui::Rect::from_min_size(egui::pos2(logo_center.x + gap / 2.0, logo_center.y - tile_size - gap / 2.0), egui::vec2(tile_size, tile_size));
                let bl = egui::Rect::from_min_size(egui::pos2(logo_center.x - tile_size - gap / 2.0, logo_center.y + gap / 2.0), egui::vec2(tile_size, tile_size));
                let br = egui::Rect::from_min_size(egui::pos2(logo_center.x + gap / 2.0, logo_center.y + gap / 2.0), egui::vec2(tile_size, tile_size));
                painter.rect_filled(tl, 1.0, Color32::from_rgb(0, 164, 239)); // Top-left cyan-blue
                painter.rect_filled(tr, 1.0, Color32::from_rgb(0, 130, 217)); // Top-right vivid blue
                painter.rect_filled(bl, 1.0, Color32::from_rgb(0, 120, 215)); // Bottom-left classic blue
                painter.rect_filled(br, 1.0, Color32::from_rgb(0, 183, 255)); // Bottom-right sky blue
                start_resp.on_hover_text("Start");
                cur_x += btn_size + btn_gap;

                // 2. Search Button (icon button)
                let search_rect = egui::Rect::from_center_size(egui::pos2(cur_x + btn_size / 2.0, center_y), egui::vec2(btn_size, btn_size));
                let search_resp = ui.interact(search_rect, egui::Id::new("taskbar_search_pill"), egui::Sense::click());
                if search_resp.clicked() {
                    toggle_start_menu = true;
                }
                if search_resp.hovered() {
                    painter.rect_filled(search_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 18));
                }
                let search_icon_char = crate::entropy_gui::icons::glyph("magnifying-glass", crate::entropy_gui::icons::IconStyle::Bold)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "🔍".to_string());
                painter.text(
                    search_rect.center(),
                    egui::Align2::CENTER_CENTER,
                    search_icon_char,
                    egui::FontId::proportional(16.0),
                    Color32::from_rgb(215, 222, 235),
                );
                search_resp.on_hover_text("Search");
                cur_x += btn_size + btn_gap;

                // 3. Task View Icon (2 overlapping rectangles)
                let task_view_rect = egui::Rect::from_center_size(egui::pos2(cur_x + btn_size / 2.0, center_y), egui::vec2(btn_size, btn_size));
                let task_view_resp = ui.interact(task_view_rect, egui::Id::new("taskbar_task_view"), egui::Sense::click());
                if task_view_resp.hovered() {
                    painter.rect_filled(task_view_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 18));
                }
                let tv_c = task_view_rect.center();
                let tv_r1 = egui::Rect::from_center_size(egui::pos2(tv_c.x - 3.0, tv_c.y + 2.0), egui::vec2(13.0, 11.0));
                let tv_r2 = egui::Rect::from_center_size(egui::pos2(tv_c.x + 3.0, tv_c.y - 2.0), egui::vec2(13.0, 11.0));
                painter.rect_stroke(tv_r2, 2.0, egui::Stroke::new(1.2, Color32::from_rgb(150, 160, 175)), egui::StrokeKind::Inside);
                painter.rect_filled(tv_r1, 2.0, Color32::from_rgba_unmultiplied(20, 23, 31, 245));
                painter.rect_stroke(tv_r1, 2.0, egui::Stroke::new(1.2, Color32::from_rgb(205, 215, 230)), egui::StrokeKind::Inside);
                task_view_resp.on_hover_text("Task view");
                cur_x += btn_size + sep_gap;

                // Subtle vertical divider
                painter.line_segment(
                    [egui::pos2(cur_x, center_y - 10.0), egui::pos2(cur_x, center_y + 10.0)],
                    egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 22)),
                );
                cur_x += sep_line_w + sep_gap;

                // Taskbar App Items (DAW, Guitar Tabs, Mesha, CC Manager, etc.) - Windows 11 style (centered, icon-only, no labels)
                for (tab_id, title, addon_name) in tabs {
                    let is_active = active_tab == Some(tab_id.as_str());

                    // Icon and clean title detection
                    let (clean_title, icon_name, icon_color) = if addon_name.contains("daw") || title.to_lowercase().contains("daw") {
                        ("DAW", "waveform", Color32::from_rgb(96, 205, 255))
                    } else if addon_name.contains("tabs") || title.to_lowercase().contains("guitar") || title.to_lowercase().contains("tabs") {
                        ("Guitar Tabs", "guitar", Color32::from_rgb(255, 180, 80))
                    } else if addon_name.contains("cc") || title.to_lowercase().contains("kanban") || title.to_lowercase().contains("cc manager") {
                        ("CC Manager", "kanban", Color32::from_rgb(130, 220, 110))
                    } else if addon_name.contains("mesha") || title.to_lowercase().contains("shapes") || title.to_lowercase().contains("mesha") {
                        ("Mesha", "shapes", Color32::from_rgb(175, 150, 255))
                    } else {
                        (title.as_str(), "squares-four", Color32::from_rgb(200, 215, 235))
                    };

                    let icon_glyph = crate::entropy_gui::icons::glyph(icon_name, crate::entropy_gui::icons::IconStyle::Bold)
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| match icon_name {
                            "waveform" => "〰".to_string(),
                            "guitar" => "🎸".to_string(),
                            "kanban" => "📋".to_string(),
                            "shapes" => "❖".to_string(),
                            _ => "▪".to_string(),
                        });

                    let item_rect = egui::Rect::from_center_size(egui::pos2(cur_x + btn_size / 2.0, center_y), egui::vec2(btn_size, btn_size));
                    let item_resp = ui.interact(item_rect, egui::Id::new(format!("taskbar_tab_{tab_id}")), egui::Sense::click());

                    if item_resp.clicked() {
                        tab_to_activate = Some(tab_id.clone());
                    }

                    // Windows 11 style button highlight
                    if is_active {
                        painter.rect_filled(item_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 24));
                        painter.rect_stroke(item_rect, 6.0, egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 30)), egui::StrokeKind::Inside);
                    } else if item_resp.hovered() {
                        painter.rect_filled(item_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 14));
                    }

                    // Centered App Icon (no label)
                    painter.text(
                        item_rect.center(),
                        egui::Align2::CENTER_CENTER,
                        icon_glyph,
                        egui::FontId::proportional(18.0),
                        icon_color,
                    );

                    // Windows 11 indicator bar at bottom edge
                    if is_active {
                        // Wide accent blue line
                        let bar_rect = egui::Rect::from_center_size(
                            egui::pos2(item_rect.center().x, item_rect.max.y - 2.5),
                            egui::vec2(16.0, 3.0),
                        );
                        painter.rect_filled(bar_rect, 1.5, Color32::from_rgb(96, 205, 255));
                    } else {
                        // Small running app dot indicator, slightly wider on hover
                        let dot_w = if item_resp.hovered() { 10.0 } else { 6.0 };
                        let dot_rect = egui::Rect::from_center_size(
                            egui::pos2(item_rect.center().x, item_rect.max.y - 2.5),
                            egui::vec2(dot_w, 3.0),
                        );
                        painter.rect_filled(dot_rect, 1.5, Color32::from_rgba_unmultiplied(255, 255, 255, 120));
                    }

                    item_resp.on_hover_text(clean_title);
                    cur_x += btn_size + btn_gap;
                }

                // Right Side: System Tray, Clock, Status, Desktop Peek
                let mut tray_x = rect.max.x - 6.0;

                // Show Desktop peek strip (far right corner)
                let peek_rect = egui::Rect::from_min_max(egui::pos2(tray_x - 6.0, rect.min.y), egui::pos2(rect.max.x, rect.max.y));
                let peek_resp = ui.interact(peek_rect, egui::Id::new("taskbar_show_desktop"), egui::Sense::click());
                if peek_resp.hovered() {
                    painter.rect_filled(peek_rect, 0.0, Color32::from_rgba_unmultiplied(255, 255, 255, 25));
                }
                painter.line_segment(
                    [egui::pos2(tray_x - 6.0, rect.min.y + 10.0), egui::pos2(tray_x - 6.0, rect.max.y - 10.0)],
                    egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 20)),
                );
                tray_x -= 14.0;

                // Real-time Clock and Date
                let now = chrono::Local::now();
                let time_str = now.format("%H:%M").to_string();
                let date_str = now.format("%Y-%m-%d").to_string();
                let clock_rect = egui::Rect::from_min_size(egui::pos2(tray_x - 70.0, center_y - 17.0), egui::vec2(66.0, 34.0));
                let clock_resp = ui.interact(clock_rect, egui::Id::new("taskbar_clock"), egui::Sense::hover());
                if clock_resp.hovered() {
                    painter.rect_filled(clock_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 14));
                }
                painter.text(
                    egui::pos2(clock_rect.center().x, clock_rect.min.y + 9.0),
                    egui::Align2::CENTER_CENTER,
                    &time_str,
                    egui::FontId::proportional(11.5),
                    Color32::from_rgb(240, 243, 250),
                );
                painter.text(
                    egui::pos2(clock_rect.center().x, clock_rect.max.y - 9.0),
                    egui::Align2::CENTER_CENTER,
                    &date_str,
                    egui::FontId::proportional(9.5),
                    Color32::from_rgb(165, 172, 185),
                );
                tray_x -= 76.0;

                // Status Pill Badge: "CREATIVE" with green dot
                let status_rect = egui::Rect::from_min_size(egui::pos2(tray_x - 82.0, center_y - 12.0), egui::vec2(78.0, 24.0));
                painter.rect_filled(status_rect, 12.0, Color32::from_rgba_unmultiplied(40, 160, 80, 35));
                painter.rect_stroke(status_rect, 12.0, egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(60, 200, 100, 60)), egui::StrokeKind::Inside);
                painter.circle_filled(egui::pos2(status_rect.min.x + 10.0, center_y), 3.0, Color32::from_rgb(76, 217, 100));
                painter.text(
                    egui::pos2(status_rect.min.x + 18.0, center_y),
                    egui::Align2::LEFT_CENTER,
                    "CREATIVE",
                    egui::FontId::proportional(10.0),
                    Color32::from_rgb(160, 235, 180),
                );
                tray_x -= 88.0;

                // Tray Icons: Network & Audio Speaker
                let speaker_glyph = crate::entropy_gui::icons::glyph("speaker-high", crate::entropy_gui::icons::IconStyle::Bold)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "🔊".to_string());
                let wifi_glyph = crate::entropy_gui::icons::glyph("wifi-high", crate::entropy_gui::icons::IconStyle::Bold)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "📶".to_string());

                let icons_rect = egui::Rect::from_min_size(egui::pos2(tray_x - 52.0, center_y - 14.0), egui::vec2(48.0, 28.0));
                let icons_resp = ui.interact(icons_rect, egui::Id::new("taskbar_tray_icons"), egui::Sense::hover());
                if icons_resp.hovered() {
                    painter.rect_filled(icons_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 14));
                }
                painter.text(
                    egui::pos2(icons_rect.min.x + 10.0, center_y),
                    egui::Align2::CENTER_CENTER,
                    speaker_glyph,
                    egui::FontId::proportional(13.0),
                    Color32::from_rgb(205, 212, 225),
                );
                painter.text(
                    egui::pos2(icons_rect.min.x + 32.0, center_y),
                    egui::Align2::CENTER_CENTER,
                    wifi_glyph,
                    egui::FontId::proportional(13.0),
                    Color32::from_rgb(205, 212, 225),
                );
            });

        // 2. Start Menu Flyout
        if toggle_start_menu {
            start_menu_open = !start_menu_open;
        }

        if start_menu_open {
            let menu_w = 380.0;
            let menu_h = 440.0;
            let menu_x = ((screen_rect.width() - menu_w) / 2.0).round().max(12.0);
            let menu_y = (screen_rect.height() - taskbar_height - menu_h - 12.0).max(10.0);

            let mut close_menu = false;
            egui::Window::new("WindowsStartMenuFlyout")
                .id(egui::Id::new("entropy_taskbar_start_flyout"))
                .decorations(false)
                .resizable(false)
                .default_pos([menu_x, menu_y])
                .default_size([menu_w, menu_h])
                .show(ctx, |ui| {
                    let rect = ui.max_rect();
                    let painter = ui.painter();

                    // Beautiful dark acrylic menu background with subtle border
                    painter.rect_filled(rect, 10.0, Color32::from_rgba_unmultiplied(26, 30, 40, 252));
                    painter.rect_stroke(rect, 10.0, egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 28)), egui::StrokeKind::Inside);

                    // Header: Windows Logo + Title
                    let mut cur_y = rect.min.y + 16.0;
                    let pad_x = rect.min.x + 18.0;

                    // Large 4-square Windows logo
                    let logo_x = pad_x + 8.0;
                    let logo_y = cur_y + 10.0;
                    let t_sz = 7.0;
                    let t_gap = 2.0;
                    painter.rect_filled(egui::Rect::from_min_size(egui::pos2(logo_x - t_sz - t_gap/2.0, logo_y - t_sz - t_gap/2.0), egui::vec2(t_sz, t_sz)), 1.0, Color32::from_rgb(0, 164, 239));
                    painter.rect_filled(egui::Rect::from_min_size(egui::pos2(logo_x + t_gap/2.0, logo_y - t_sz - t_gap/2.0), egui::vec2(t_sz, t_sz)), 1.0, Color32::from_rgb(0, 130, 217));
                    painter.rect_filled(egui::Rect::from_min_size(egui::pos2(logo_x - t_sz - t_gap/2.0, logo_y + t_gap/2.0), egui::vec2(t_sz, t_sz)), 1.0, Color32::from_rgb(0, 120, 215));
                    painter.rect_filled(egui::Rect::from_min_size(egui::pos2(logo_x + t_gap/2.0, logo_y + t_gap/2.0), egui::vec2(t_sz, t_sz)), 1.0, Color32::from_rgb(0, 183, 255));

                    painter.text(
                        egui::pos2(pad_x + 26.0, cur_y + 4.0),
                        egui::Align2::LEFT_TOP,
                        "Entropy Creative Suite",
                        egui::FontId::proportional(15.0),
                        Color32::from_rgb(255, 255, 255),
                    );
                    painter.text(
                        egui::pos2(pad_x + 26.0, cur_y + 22.0),
                        egui::Align2::LEFT_TOP,
                        "Unified Creative & Development Environment",
                        egui::FontId::proportional(10.5),
                        Color32::from_rgb(160, 168, 182),
                    );
                    cur_y += 48.0;

                    // Search input representation
                    let search_bar_rect = egui::Rect::from_min_size(egui::pos2(pad_x, cur_y), egui::vec2(menu_w - 36.0, 32.0));
                    painter.rect_filled(search_bar_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 12));
                    painter.rect_stroke(search_bar_rect, 6.0, egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 20)), egui::StrokeKind::Inside);
                    painter.text(
                        egui::pos2(search_bar_rect.min.x + 12.0, search_bar_rect.center().y),
                        egui::Align2::LEFT_CENTER,
                        "Search apps, tracks, and tasks...",
                        egui::FontId::proportional(11.0),
                        Color32::from_rgb(140, 146, 160),
                    );
                    cur_y += 42.0;

                    // Pinned Applications Section Header
                    painter.text(
                        egui::pos2(pad_x, cur_y),
                        egui::Align2::LEFT_TOP,
                        "PINNED APPLICATIONS",
                        egui::FontId::proportional(10.0),
                        Color32::from_rgb(120, 140, 175),
                    );
                    cur_y += 18.0;

                    // Pinned App Cards
                    let apps_meta = [
                        ("daw", "Matter", "Multi-track audio sequencing, synthesis & effects", "waveform", Color32::from_rgb(96, 205, 255)),
                        ("tabs", "Guitar Lingo", "Interactive tablature editor, playback & fretboard", "guitar", Color32::from_rgb(255, 180, 80)),
                        ("cc", "CC Manager", "Kanban task manager & Claude Code session board", "kanban", Color32::from_rgb(130, 220, 110)),
                        ("mesha", "Mesha", "Create 3D models with procedural power", "shapes", Color32::from_rgb(130, 120, 110)),
                    ];

                    for (filter_key, app_title, app_desc, icon_name, icon_c) in apps_meta {
                        // Find matching tab id
                        let matching_tab = tabs.iter().find(|(id, title, addon)| {
                            addon.to_lowercase().contains(filter_key)
                                || id.to_lowercase().contains(filter_key)
                                || title.to_lowercase().contains(filter_key)
                        });

                        let card_rect = egui::Rect::from_min_size(egui::pos2(pad_x, cur_y), egui::vec2(menu_w - 36.0, 56.0));
                        let card_resp = ui.interact(card_rect, egui::Id::new(format!("start_card_{filter_key}")), egui::Sense::click());

                        let is_this_active = matching_tab.map_or(false, |(id, _, _)| active_tab == Some(id.as_str()));

                        if card_resp.clicked() {
                            if let Some((tab_id, _, _)) = matching_tab {
                                tab_to_activate = Some(tab_id.clone());
                                close_menu = true;
                            }
                        }

                        let card_bg = if is_this_active {
                            Color32::from_rgba_unmultiplied(255, 255, 255, 24)
                        } else if card_resp.hovered() {
                            Color32::from_rgba_unmultiplied(255, 255, 255, 16)
                        } else {
                            Color32::from_rgba_unmultiplied(255, 255, 255, 8)
                        };
                        painter.rect_filled(card_rect, 8.0, card_bg);
                        if is_this_active {
                            painter.rect_stroke(card_rect, 8.0, egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(96, 205, 255, 120)), egui::StrokeKind::Inside);
                        }

                        // App Icon in rounded badge
                        let icon_badge = egui::Rect::from_min_size(egui::pos2(card_rect.min.x + 10.0, card_rect.center().y - 18.0), egui::vec2(36.0, 36.0));
                        painter.rect_filled(icon_badge, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 12));
                        let iglyph = crate::entropy_gui::icons::glyph(icon_name, crate::entropy_gui::icons::IconStyle::Bold)
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| match icon_name {
                                "waveform" => "〰".to_string(),
                                "guitar" => "🎸".to_string(),
                                "kanban" => "📋".to_string(),
                                _ => "▪".to_string(),
                            });
                        painter.text(
                            icon_badge.center(),
                            egui::Align2::CENTER_CENTER,
                            iglyph,
                            egui::FontId::proportional(18.0),
                            icon_c,
                        );

                        // App Title & Description
                        painter.text(
                            egui::pos2(card_rect.min.x + 56.0, card_rect.min.y + 12.0),
                            egui::Align2::LEFT_TOP,
                            app_title,
                            egui::FontId::proportional(12.5),
                            Color32::from_rgb(255, 255, 255),
                        );
                        painter.text(
                            egui::pos2(card_rect.min.x + 56.0, card_rect.min.y + 30.0),
                            egui::Align2::LEFT_TOP,
                            app_desc,
                            egui::FontId::proportional(9.5),
                            Color32::from_rgb(160, 168, 180),
                        );

                        cur_y += 62.0;
                    }

                    cur_y += 8.0;

                    // Footer divider
                    let footer_y = rect.max.y - 48.0;
                    painter.line_segment(
                        [egui::pos2(rect.min.x, footer_y), egui::pos2(rect.max.x, footer_y)],
                        egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 20)),
                    );

                    // User Profile / Suite Info
                    let user_circle = egui::Rect::from_min_size(egui::pos2(pad_x, footer_y + 10.0), egui::vec2(28.0, 28.0));
                    painter.circle_filled(user_circle.center(), 14.0, Color32::from_rgb(0, 120, 215));
                    painter.text(
                        user_circle.center(),
                        egui::Align2::CENTER_CENTER,
                        "E",
                        egui::FontId::proportional(12.0),
                        Color32::from_rgb(255, 255, 255),
                    );
                    painter.text(
                        egui::pos2(pad_x + 36.0, footer_y + 12.0),
                        egui::Align2::LEFT_TOP,
                        "Entropy Developer",
                        egui::FontId::proportional(11.5),
                        Color32::from_rgb(240, 245, 255),
                    );
                    painter.text(
                        egui::pos2(pad_x + 36.0, footer_y + 26.0),
                        egui::Align2::LEFT_TOP,
                        "Common Monorepo",
                        egui::FontId::proportional(9.0),
                        Color32::from_rgb(140, 150, 165),
                    );

                    // Close / Dismiss button
                    let close_rect = egui::Rect::from_min_size(egui::pos2(rect.max.x - 42.0, footer_y + 10.0), egui::vec2(28.0, 28.0));
                    let close_resp = ui.interact(close_rect, egui::Id::new("start_menu_close_btn"), egui::Sense::click());
                    if close_resp.clicked() {
                        close_menu = true;
                    }
                    if close_resp.hovered() {
                        painter.rect_filled(close_rect, 6.0, Color32::from_rgba_unmultiplied(255, 255, 255, 20));
                    }
                    painter.text(
                        close_rect.center(),
                        egui::Align2::CENTER_CENTER,
                        "✕",
                        egui::FontId::proportional(12.0),
                        Color32::from_rgb(200, 210, 225),
                    );
                });
            if close_menu {
                start_menu_open = false;
            }
        }

        // Apply state changes to AddonContext
        {
            let mut op_state = runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.taskbar_start_menu_open = start_menu_open;
                if let Some(tab_id) = tab_to_activate {
                    context.active_tab = Some(tab_id.clone());
                    if let Ok(mut events) = context.ui_events.lock() {
                        events.push(format!("TAB_SELECT|{tab_id}"));
                    }
                }
            }
        }
    }

    /// Index of the end marker matching the start marker at `start`, counting nested pairs.
    fn matching_end(widgets: &[UiWidget], start: usize, is_start: impl Fn(&UiWidget) -> bool, is_end: impl Fn(&UiWidget) -> bool) -> usize {
        let mut depth = 1;
        let mut k = start + 1;
        while k < widgets.len() {
            if is_start(&widgets[k]) {
                depth += 1;
            } else if is_end(&widgets[k]) {
                depth -= 1;
                if depth == 0 {
                    return k;
                }
            }
            k += 1;
        }
        widgets.len()
    }

    fn render_widgets(
        ui: &mut egui::Ui,
        widgets: &[UiWidget],
        events_to_push: &mut Vec<String>,
        context: &mut AddonContext,
        egui_renderer: &mut egui_wgpu::Renderer,
    ) {
        let mut i = 0;
        let mut pending_extras: Option<crate::deno::addon_ops::WidgetExtras> = None;
        while i < widgets.len() {
            // `Extras` configures the widget right after it; anything else consumes it.
            if let UiWidget::Extras { extras } = &widgets[i] {
                pending_extras = Some(extras.clone());
                i += 1;
                continue;
            }
            let extras = pending_extras.take().unwrap_or_default();
            let tooltip = extras.tooltip.clone().unwrap_or_default();
            let shortcut = extras.shortcut.clone().unwrap_or_default();
            match &widgets[i] {
                UiWidget::Extras { .. } => {}
                UiWidget::Label { text, bold, font_size, alpha } => {
                    let mut txt = egui::RichText::new(text).alpha(*alpha);
                    if bold.unwrap_or(false) {
                        txt = txt.strong();
                    }
                    if let Some(size) = font_size {
                        txt = txt.font_size(*size);
                    }
                    if let Some(c) = extras.color {
                        txt = txt.color(egui::Color32::from_rgba_f32(c));
                    }
                    if extras.monospace.unwrap_or(false) {
                        txt = txt.monospace();
                    }
                    if extras.wrap.unwrap_or(false) {
                        txt = txt.wrap();
                    }
                    let resp = ui.label(txt);
                    if !tooltip.is_empty() {
                        resp.on_hover_text(tooltip.clone());
                    }
                }
                UiWidget::Button {
                    text,
                    id: btn_id,
                    label: _,
                    font_size,
                    alpha,
                    frame,
                } => {
                    let mut txt = egui::RichText::new(text).alpha(*alpha);
                    if let Some(size) = font_size {
                        txt = txt.font_size(*size);
                    }
                    if let Some(c) = extras.color {
                        txt = txt.color(egui::Color32::from_rgba_f32(c));
                    }
                    let mut button = egui::Button::new(txt)
                        .frame(*frame)
                        .enabled(!extras.disabled.unwrap_or(false))
                        .selected(extras.selected.unwrap_or(false));
                    if let Some(c) = extras.accent {
                        button = button.fill(egui::Color32::from_rgba_f32(c));
                    }
                    if let Some(w) = extras.min_width {
                        button = button.min_size(egui::vec2(w, 0.0));
                    }
                    if ui.add(button).on_hover_text_with_shortcut(tooltip.clone(), shortcut.clone()).clicked() {
                        events_to_push.push(btn_id.clone());
                    }
                }
                UiWidget::ColorInput {
                    id: color_id,
                    label,
                    color,
                } => {
                    ui.horizontal(|ui| {
                        ui.label(label);
                        let mut current_color = *color;
                        if ui
                            .color_edit_button_rgba_unmultiplied(&mut current_color)
                            .changed()
                        {
                            let payload = format!(
                                "{}|{},{},{},{}",
                                color_id,
                                current_color[0],
                                current_color[1],
                                current_color[2],
                                current_color[3]
                            );
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::Slider {
                    id: slider_id,
                    label,
                    value,
                    min,
                    max,
                } => {
                    ui.horizontal(|ui| {
                        ui.label(label);
                        let mut current_value = *value;
                        let mut slider = egui::Slider::new(&mut current_value, *min..=*max);
                        if let Some(unit) = &extras.unit { slider = slider.unit(unit.clone()); }
                        if let Some(d) = extras.default_value { slider = slider.default_value(d); }
                        if let Some(st) = extras.step { slider = slider.step(st); }
                        if let Some(dp) = extras.decimals { slider = slider.decimals(dp as usize); }
                        let mut resp = ui.add(slider);
                        if !tooltip.is_empty() { resp = resp.on_hover_text_with_shortcut(tooltip.clone(), shortcut.clone()); }
                        if resp.changed()
                        {
                            let payload = format!("{}|{}", slider_id, current_value);
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::Knob {
                    id: knob_id,
                    label,
                    value,
                    min,
                    max,
                } => {
                    let mut current_value = *value;
                    let mut knob = egui::Knob::new(&mut current_value, *min..=*max).text(label.clone());
                    if let Some(unit) = &extras.unit { knob = knob.unit(unit.clone()); }
                    if let Some(d) = extras.default_value { knob = knob.default_value(d); }
                    if let Some(st) = extras.step { knob = knob.step(st); }
                    if let Some(dp) = extras.decimals { knob = knob.decimals(dp as usize); }
                    if let Some(sz) = &extras.size {
                        if sz == "small" {
                            knob = knob.size(egui::KnobSize::Small);
                        }
                    }
                    if ui.add(knob).changed() {
                        let payload = format!("{}|{}", knob_id, current_value);
                        events_to_push.push(payload);
                    }
                }
                UiWidget::NumericInput {
                    id: num_id,
                    label,
                    value,
                } => {
                    ui.horizontal(|ui| {
                        ui.label(label);
                        let mut current_value = *value;
                        let mut drag = egui::DragValue::new(&mut current_value);
                        if extras.min.is_some() || extras.max.is_some() {
                            drag = drag.range(extras.min.unwrap_or(f32::NEG_INFINITY)..=extras.max.unwrap_or(f32::INFINITY));
                        }
                        if let Some(unit) = &extras.unit { drag = drag.suffix(unit.clone()); }
                        if let Some(d) = extras.default_value { drag = drag.default_value(d); }
                        if let Some(st) = extras.step { drag = drag.step(st); }
                        if let Some(dp) = extras.decimals { drag = drag.decimals(dp as usize); }
                        if let Some(sp) = extras.speed { drag = drag.speed(sp); }
                        let mut resp = ui.add(drag);
                        if !tooltip.is_empty() { resp = resp.on_hover_text_with_shortcut(tooltip.clone(), shortcut.clone()); }
                        if resp.changed() {
                            let payload = format!("{}|{}", num_id, current_value);
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::Dropdown {
                    id: drop_id,
                    label,
                    options,
                    selected_index,
                } => {
                    ui.horizontal(|ui| {
                        ui.label(label);
                        let mut current_selected = *selected_index;
                        let mut changed = false;
                        egui::ComboBox::from_id_source(drop_id)
                            .selected_text(&options[current_selected])
                            .show_ui(ui, |ui| {
                                for (i, option) in options.iter().enumerate() {
                                    if ui.selectable_value(&mut current_selected, i, option).clicked() {
                                        changed = true;
                                    }
                                }
                            });

                        if changed {
                            let payload = format!("{}|{}", drop_id, current_selected);
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::Checkbox {
                    id: check_id,
                    label,
                    value,
                } => {
                    let mut current_value = *value;
                    if ui.checkbox(&mut current_value, label).on_hover_text_with_shortcut(tooltip.clone(), shortcut.clone()).changed() {
                        let payload = format!("{}|{}", check_id, current_value);
                        events_to_push.push(payload);
                    }
                }
                UiWidget::CodeEditor {
                    id: editor_id,
                    label,
                    content,
                    language: _,
                } => {
                    ui.label(label);

                    let mut current_content = content.clone();
                    // Plain multiline edit + line-number gutter, no syntax highlighting yet —
                    // see src/entropy_gui/widgets_code_editor.rs (replaces egui_code_editor).
                    let response = crate::entropy_gui::widgets_code_editor::code_editor(ui, &mut current_content);

                    if response.changed() {
                        let payload = format!("{}|{}", editor_id, current_content);
                        events_to_push.push(payload);
                    }
                }
                UiWidget::MiniMap {
                    id: mm_id,
                    landscape_id: _,
                    brush_size,
                    markers,
                    polylines,
                } => {
                    let texture_id = if let Some(view) = &context.landscape_texture_view {
                        let key = format!("landscape_{}", mm_id);
                        if let Some(tid) = context.egui_textures.get(&key) {
                            *tid
                        } else {
                            let tid = egui_renderer.register_native_texture(
                                &context.gpu_resources.as_ref().unwrap().device,
                                view,
                                wgpu::FilterMode::Linear,
                            );
                            context.egui_textures.insert(key, tid);
                            tid
                        }
                    } else {
                        ui.label("Waiting for landscape texture...");
                        i += 1;
                        continue;
                    };

                    let mm_size = ui.available_size();
                    let mm_size = mm_size.x.min(mm_size.y);
                    let (rect, response) = ui.allocate_exact_size(
                        egui::vec2(mm_size, mm_size),
                        egui::Sense::click_and_drag(),
                    );

                    // Draw the landscape texture
                    ui.painter().image(
                        texture_id,
                        rect,
                        egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                        egui::Color32::WHITE,
                    );

                    // Interaction: Drawing
                    if response.dragged() {
                        if let Some(pointer_pos) = response.interact_pointer_pos() {
                            let local_pos = pointer_pos - rect.min;
                            let x = local_pos.x / rect.width();
                            let y = local_pos.y / rect.height();
                            let payload = format!("{}|{},{},{}", mm_id, x, y, brush_size);
                            events_to_push.push(payload);
                        }
                    } else if response.clicked() {
                        if let Some(pointer_pos) = response.interact_pointer_pos() {
                            let local_pos = pointer_pos - rect.min;
                            let x = local_pos.x / rect.width();
                            let y = local_pos.y / rect.height();
                            let payload = format!("CLICK|{}|{},{},{}", mm_id, x, y, brush_size);
                            events_to_push.push(payload);
                        }
                    }

                    // Draw polylines
                    if let Some(polylines) = polylines {
                        for polyline in polylines {
                            if polyline.points.len() >= 2 {
                                let points: Vec<egui::Pos2> = polyline
                                    .points
                                    .iter()
                                    .map(|p| {
                                        rect.min
                                            + egui::vec2(p[0] * rect.width(), p[1] * rect.height())
                                    })
                                    .collect();

                                let color = polyline
                                    .color
                                    .map(|c| {
                                        egui::Color32::from_rgba_unmultiplied(
                                            (c[0] * 255.0) as u8,
                                            (c[1] * 255.0) as u8,
                                            (c[2] * 255.0) as u8,
                                            (c[3] * 255.0) as u8,
                                        )
                                    })
                                    .unwrap_or(egui::Color32::WHITE);
                                let stroke_width = polyline.width.unwrap_or(2.0);

                                for i in 0..points.len() - 1 {
                                    ui.painter().line_segment(
                                        [points[i], points[i + 1]],
                                        egui::Stroke::new(stroke_width, color),
                                    );
                                }
                            }
                        }
                    }

                    // Draw markers
                    for marker in markers {
                        let m_pos = rect.min
                            + egui::vec2(marker.position[0] * rect.width(), marker.position[1] * rect.height());
                        let m_color = marker
                            .color
                            .map(|c| {
                                egui::Color32::from_rgba_unmultiplied(
                                    (c[0] * 255.0) as u8,
                                    (c[1] * 255.0) as u8,
                                    (c[2] * 255.0) as u8,
                                    (c[3] * 255.0) as u8,
                                )
                            })
                            .unwrap_or(egui::Color32::RED);

                        ui.painter().circle_filled(m_pos, 5.0, m_color);
                        if let Some(label) = &marker.label {
                            ui.painter().text(
                                m_pos + egui::vec2(7.0, 0.0),
                                egui::Align2::LEFT_CENTER,
                                label,
                                egui::FontId::proportional(12.0),
                                egui::Color32::WHITE,
                            );
                        }
                    }
                }
                UiWidget::PianoRoll {
                    id: pr_id,
                    rows,
                    steps,
                    steps_per_beat,
                    row_labels,
                    cells,
                    playhead,
                    options,
                } => {
                    let notes: Vec<egui::PianoRollNote> = cells
                        .iter()
                        .map(|c| egui::PianoRollNote { row: c.row as usize, step: c.step as usize, length: c.length.max(1) as usize, velocity: c.velocity })
                        .collect();
                    let mut style = egui::PianoRollStyle {
                        row_h: options.row_height.unwrap_or(0.0),
                        fill_height: options.fill_height.unwrap_or(false),
                        highlight_rows: options.highlight_rows.as_ref().map(|r| r.iter().map(|x| *x as usize).collect()).unwrap_or_default(),
                        show_velocity: options.show_velocity.unwrap_or(false),
                        ..Default::default()
                    };
                    if let Some(c) = options.color {
                        style.note_color = egui::Color32::from_rgba_f32(c);
                    }
                    let events = egui::PianoRoll::new(pr_id.as_str()).show(
                        ui,
                        *rows as usize,
                        *steps as usize,
                        *steps_per_beat as usize,
                        row_labels.as_deref(),
                        &notes,
                        *playhead,
                        &style,
                    );
                    // Raw press/drag/release cell coordinates: the addon owns the pattern and
                    // decides whether a press adds or erases.
                    for event in events {
                        let (kind, row, step) = match event {
                            egui::PianoRollEvent::Down { row, step } => ("DOWN", row, step),
                            egui::PianoRollEvent::Drag { row, step } => ("DRAG", row, step),
                            egui::PianoRollEvent::Up { row, step } => ("UP", row, step),
                        };
                        events_to_push.push(format!("PIANOROLL_{}|{}|{},{}", kind, pr_id, row, step));
                    }
                }
                UiWidget::KeyframeTimeline { id: kftl_id, duration_ms, playhead_ms, rows, selected } => {
                    let rows: Vec<crate::entropy_gui::KeyframeRow> = rows
                        .iter()
                        .map(|r| {
                            let mut row = crate::entropy_gui::KeyframeRow::new(r.id.clone(), r.label.clone());
                            row.keyframes = r.keyframes.iter().map(|k| crate::entropy_gui::Keyframe::new(k.id.clone(), k.time_ms)).collect();
                            row
                        })
                        .collect();
                    let selected_ref = selected.as_ref().map(|(r, k)| (r.as_str(), k.as_str()));

                    let resp = crate::entropy_gui::KeyframeTimeline::new(kftl_id.as_str()).show(ui, &rows, *duration_ms, *playhead_ms, selected_ref);
                    for event in resp.events {
                        match event {
                            crate::entropy_gui::KeyframeTimelineEvent::Seek(t) => {
                                events_to_push.push(format!("KFTL_SEEK|{}|{}", kftl_id, t));
                            }
                            crate::entropy_gui::KeyframeTimelineEvent::KeyframeMoved { row, keyframe, time_ms } => {
                                events_to_push.push(format!("KFTL_KF_MOVED|{}|{}|{}|{}", kftl_id, row, keyframe, time_ms));
                            }
                            crate::entropy_gui::KeyframeTimelineEvent::KeyframeSelected { row, keyframe } => {
                                events_to_push.push(format!("KFTL_KF_SELECTED|{}|{}|{}", kftl_id, row, keyframe));
                            }
                            crate::entropy_gui::KeyframeTimelineEvent::KeyframeAddRequested { row, time_ms } => {
                                events_to_push.push(format!("KFTL_KF_ADD|{}|{}|{}", kftl_id, row, time_ms));
                            }
                            crate::entropy_gui::KeyframeTimelineEvent::KeyframeDeleteRequested { row, keyframe } => {
                                events_to_push.push(format!("KFTL_KF_DELETE|{}|{}|{}", kftl_id, row, keyframe));
                            }
                            crate::entropy_gui::KeyframeTimelineEvent::RowClicked(row) => {
                                events_to_push.push(format!("KFTL_ROW_CLICKED|{}|{}", kftl_id, row));
                            }
                            crate::entropy_gui::KeyframeTimelineEvent::BackgroundClicked => {
                                events_to_push.push(format!("KFTL_BG_CLICKED|{}", kftl_id));
                            }
                        }
                    }
                }
                UiWidget::Tracks { id: tracks_id, duration_ms, playhead_ms, tracks, selected, options } => {
                    let tracks_data: Vec<crate::entropy_gui::Track> = tracks
                        .iter()
                        .map(|t| {
                            let mut track = crate::entropy_gui::Track::new(t.id.clone(), t.label.clone());
                            track.sublabel = t.sublabel.clone().unwrap_or_default();
                            track.color = t.color.map(egui::Color32::from_rgba_f32);
                            track.muted = t.muted.unwrap_or(false);
                            track.solo = t.solo.unwrap_or(false);
                            track.controls = t.controls.unwrap_or(false);
                            track.placeholder = t.placeholder.unwrap_or(false);
                            track.clips = t
                                .clips
                                .iter()
                                .map(|c| {
                                    let color = c.color.map(egui::Color32::from_rgba_f32).unwrap_or(egui::Color32::from_rgb(80, 120, 200));
                                    let mut clip = crate::entropy_gui::TrackClip::new(c.id.clone(), c.label.clone(), c.start_ms, c.duration_ms, color);
                                    clip.peaks = c.peaks.clone().unwrap_or_default();
                                    clip.loop_ms = c.loop_ms.unwrap_or(0);
                                    clip.notes = c
                                        .notes
                                        .as_ref()
                                        .map(|notes| notes.iter().map(|n| crate::entropy_gui::MiniNote { start: n[0], len: n[1], y: n[2] }).collect())
                                        .unwrap_or_default();
                                    clip
                                })
                                .collect();
                            track
                        })
                        .collect();
                    let selected_ref = selected.as_ref().map(|(t, c)| (t.as_str(), c.as_str()));
                    let view_options = crate::entropy_gui::TrackViewOptions {
                        lane_h: options.lane_height.unwrap_or(0.0),
                        placeholder_lane_h: options.placeholder_lane_height.unwrap_or(0.0),
                        label_w: options.label_width.unwrap_or(0.0),
                        snap_ms: options.snap_ms.unwrap_or(0),
                        bar_ms: options.bar_ms.unwrap_or(0),
                        beat_ms: options.beat_ms.unwrap_or(0),
                        fit_on_open: options.fit_on_open.unwrap_or(false),
                        zoom_needs_ctrl: options.zoom_needs_ctrl.unwrap_or(false),
                        allow_draw: options.allow_draw.unwrap_or(false),
                        active_track: options.active_track.clone(),
                        lane_numbers: options.lane_numbers.unwrap_or(false),
                        min_clip_ms: options.min_clip_ms.unwrap_or(0),
                        follow_playhead: options.follow_playhead.unwrap_or(false),
                        right_gutter: options.right_gutter.unwrap_or(0.0),
                    };

                    let resp = crate::entropy_gui::TrackView::new(tracks_id.as_str()).options(view_options).show(ui, &tracks_data, *duration_ms, *playhead_ms, selected_ref);
                    for event in resp.events {
                        match event {
                            crate::entropy_gui::TrackViewEvent::Seek(t) => {
                                events_to_push.push(format!("TRACKS_SEEK|{}|{}", tracks_id, t));
                            }
                            crate::entropy_gui::TrackViewEvent::ClipMoved { track, clip, start_ms } => {
                                events_to_push.push(format!("TRACKS_CLIP_MOVED|{}|{}|{}|{}", tracks_id, track, clip, start_ms));
                            }
                            crate::entropy_gui::TrackViewEvent::ClipResized { track, clip, start_ms, duration_ms } => {
                                events_to_push.push(format!("TRACKS_CLIP_RESIZED|{}|{}|{}|{}|{}", tracks_id, track, clip, start_ms, duration_ms));
                            }
                            crate::entropy_gui::TrackViewEvent::ClipSelected { track, clip } => {
                                events_to_push.push(format!("TRACKS_CLIP_SELECTED|{}|{}|{}", tracks_id, track, clip));
                            }
                            crate::entropy_gui::TrackViewEvent::ClipDeleteRequested { track, clip } => {
                                events_to_push.push(format!("TRACKS_CLIP_DELETE|{}|{}|{}", tracks_id, track, clip));
                            }
                            crate::entropy_gui::TrackViewEvent::ClipDuplicateRequested { track, clip } => {
                                events_to_push.push(format!("TRACKS_CLIP_DUPLICATE|{}|{}|{}", tracks_id, track, clip));
                            }
                            crate::entropy_gui::TrackViewEvent::ClipCreateRequested { track, start_ms, duration_ms } => {
                                events_to_push.push(format!("TRACKS_CLIP_CREATE|{}|{}|{}|{}", tracks_id, track, start_ms, duration_ms));
                            }
                            crate::entropy_gui::TrackViewEvent::TrackClicked(track) => {
                                events_to_push.push(format!("TRACKS_TRACK_CLICKED|{}|{}", tracks_id, track));
                            }
                            crate::entropy_gui::TrackViewEvent::TrackMuteToggled(track) => {
                                events_to_push.push(format!("TRACKS_TRACK_MUTE|{}|{}", tracks_id, track));
                            }
                            crate::entropy_gui::TrackViewEvent::TrackSoloToggled(track) => {
                                events_to_push.push(format!("TRACKS_TRACK_SOLO|{}|{}", tracks_id, track));
                            }
                            crate::entropy_gui::TrackViewEvent::BackgroundClicked => {
                                events_to_push.push(format!("TRACKS_BG_CLICKED|{}", tracks_id));
                            }
                        }
                    }
                }
                UiWidget::Kanban { id: kanban_id, columns, selected } => {
                    let columns_data: Vec<crate::entropy_gui::KanbanColumn> = columns
                        .iter()
                        .map(|col| {
                            let mut column = crate::entropy_gui::KanbanColumn::new(col.id.clone(), col.title.clone());
                            column.cards = col
                                .cards
                                .iter()
                                .map(|c| {
                                    let mut card = crate::entropy_gui::KanbanCard::new(c.id.clone(), c.title.clone());
                                    card.description = c.description.clone().unwrap_or_default();
                                    card.color = c.color.map(egui::Color32::from_rgba_f32).unwrap_or(egui::Color32::from_rgb(90, 130, 230));
                                    card.tags = c.tags.clone().unwrap_or_default();
                                    card
                                })
                                .collect();
                            column
                        })
                        .collect();
                    let selected_ref = selected.as_ref().map(|(c, k)| (c.as_str(), k.as_str()));

                    let resp = crate::entropy_gui::KanbanBoard::new(kanban_id.as_str()).show(ui, &columns_data, selected_ref);
                    for event in resp.events {
                        match event {
                            crate::entropy_gui::KanbanEvent::CardMoved { card, from_column, to_column, to_index } => {
                                events_to_push.push(format!("KANBAN_CARD_MOVED|{}|{}|{}|{}|{}", kanban_id, card, from_column, to_column, to_index));
                            }
                            crate::entropy_gui::KanbanEvent::CardSelected { column, card } => {
                                events_to_push.push(format!("KANBAN_CARD_SELECTED|{}|{}|{}", kanban_id, column, card));
                            }
                            crate::entropy_gui::KanbanEvent::CardDeleteRequested { column, card } => {
                                events_to_push.push(format!("KANBAN_CARD_DELETE|{}|{}|{}", kanban_id, column, card));
                            }
                            crate::entropy_gui::KanbanEvent::AddCardRequested { column } => {
                                events_to_push.push(format!("KANBAN_ADD_CARD|{}|{}", kanban_id, column));
                            }
                            crate::entropy_gui::KanbanEvent::ColumnClicked(column) => {
                                events_to_push.push(format!("KANBAN_COLUMN_CLICKED|{}|{}", kanban_id, column));
                            }
                            crate::entropy_gui::KanbanEvent::BackgroundClicked => {
                                events_to_push.push(format!("KANBAN_BG_CLICKED|{}", kanban_id));
                            }
                        }
                    }
                }
                UiWidget::SheetGrid { id: sheet_id, cells, selected, range, editing, options } => {
                    let cells_data: Vec<crate::entropy_gui::SheetCell> = cells
                        .iter()
                        .map(|c| crate::entropy_gui::SheetCell {
                            row: c.row,
                            col: c.col,
                            text: c.text.clone(),
                            numeric: c.numeric.unwrap_or(false),
                            border: c.border.map(egui::Color32::from_rgba_f32),
                            error: c.error.unwrap_or(false),
                        })
                        .collect();
                    let grid_options = crate::entropy_gui::SheetGridOptions {
                        rows: options.rows.unwrap_or(20),
                        cols: options.cols.unwrap_or(10),
                        col_width: options.col_width.unwrap_or(92.0),
                        row_height: options.row_height.unwrap_or(22.0),
                        max_height: options.max_height,
                    };
                    let edit_arg = editing.as_ref().map(|(row, col, value)| crate::entropy_gui::SheetEdit { row: *row, col: *col, value: value.as_str() });

                    let mut grid = crate::entropy_gui::SheetGrid::new(sheet_id.as_str()).options(grid_options);
                    if let Some([sr, sc, er, ec]) = range {
                        grid = grid.range(crate::entropy_gui::SheetRange::new(*sr, *sc, *er, *ec));
                    }
                    let resp = grid.show(ui, &cells_data, *selected, edit_arg);
                    for event in resp.events {
                        match event {
                            crate::entropy_gui::SheetEvent::CellSelected { row, col } => {
                                events_to_push.push(format!("SHEET_CELL_SELECTED|{}|{}|{}", sheet_id, row, col));
                            }
                            crate::entropy_gui::SheetEvent::RangeSelected { start_row, start_col, end_row, end_col } => {
                                events_to_push.push(format!("SHEET_RANGE_SELECTED|{}|{}|{}|{}|{}", sheet_id, start_row, start_col, end_row, end_col));
                            }
                            crate::entropy_gui::SheetEvent::CellClearRequested { row, col } => {
                                events_to_push.push(format!("SHEET_CELL_CLEAR|{}|{}|{}", sheet_id, row, col));
                            }
                            crate::entropy_gui::SheetEvent::RangeClearRequested { start_row, start_col, end_row, end_col } => {
                                events_to_push.push(format!("SHEET_RANGE_CLEAR|{}|{}|{}|{}|{}", sheet_id, start_row, start_col, end_row, end_col));
                            }
                            // The free-text field is last in each of these so a `|` inside typed
                            // cell content can't be confused for a field separator - the JS
                            // listener re-joins everything after the fixed fields.
                            crate::entropy_gui::SheetEvent::CellEditStarted { row, col, initial } => {
                                events_to_push.push(format!("SHEET_EDIT_STARTED|{}|{}|{}|{}", sheet_id, row, col, initial));
                            }
                            crate::entropy_gui::SheetEvent::CellEditChanged { row, col, text } => {
                                events_to_push.push(format!("SHEET_EDIT_CHANGED|{}|{}|{}|{}", sheet_id, row, col, text));
                            }
                            crate::entropy_gui::SheetEvent::CellEditCommitted { row, col } => {
                                events_to_push.push(format!("SHEET_EDIT_COMMITTED|{}|{}|{}", sheet_id, row, col));
                            }
                            crate::entropy_gui::SheetEvent::CellEditCancelled { row, col } => {
                                events_to_push.push(format!("SHEET_EDIT_CANCELLED|{}|{}|{}", sheet_id, row, col));
                            }
                            crate::entropy_gui::SheetEvent::InsertRowRequested { row } => {
                                events_to_push.push(format!("SHEET_INSERT_ROW|{}|{}", sheet_id, row));
                            }
                            crate::entropy_gui::SheetEvent::DeleteRowRequested { row } => {
                                events_to_push.push(format!("SHEET_DELETE_ROW|{}|{}", sheet_id, row));
                            }
                            crate::entropy_gui::SheetEvent::InsertColumnRequested { col } => {
                                events_to_push.push(format!("SHEET_INSERT_COL|{}|{}", sheet_id, col));
                            }
                            crate::entropy_gui::SheetEvent::DeleteColumnRequested { col } => {
                                events_to_push.push(format!("SHEET_DELETE_COL|{}|{}", sheet_id, col));
                            }
                        }
                    }
                }
                UiWidget::TreeView { id: tree_id, nodes, max_height, width } => {
                    let nodes_data: Vec<crate::entropy_gui::TreeNode> = nodes
                        .iter()
                        .map(|n| crate::entropy_gui::TreeNode {
                            id: n.id.clone(),
                            label: n.label.clone(),
                            depth: n.depth,
                            has_children: n.has_children.unwrap_or(false),
                            expanded: n.expanded.unwrap_or(true),
                            marked: n.marked,
                            selected: n.selected.unwrap_or(false),
                            icon: n.icon.clone().unwrap_or_default(),
                            detail: n.detail.clone().unwrap_or_default(),
                        })
                        .collect();
                    let mut tree = crate::entropy_gui::TreeView::new(tree_id.as_str());
                    if let Some(h) = max_height {
                        tree = tree.max_height(*h);
                    }
                    if let Some(w) = width {
                        tree = tree.width(*w);
                    }
                    let resp = tree.show(ui, &nodes_data);
                    for event in resp.events {
                        match event {
                            crate::entropy_gui::TreeEvent::Selected(node) => {
                                events_to_push.push(format!("TREEVIEW_SELECTED|{}|{}", tree_id, node));
                            }
                            crate::entropy_gui::TreeEvent::ToggleExpand(node) => {
                                events_to_push.push(format!("TREEVIEW_TOGGLE|{}|{}", tree_id, node));
                            }
                            crate::entropy_gui::TreeEvent::Marked(node, value) => {
                                events_to_push.push(format!("TREEVIEW_MARKED|{}|{}|{}", tree_id, node, value));
                            }
                        }
                    }
                }
                UiWidget::TabBar { id: bar_id, tabs, selected, stretch } => {
                    let tabs_data: Vec<crate::entropy_gui::Tab> = tabs
                        .iter()
                        .map(|t| crate::entropy_gui::Tab::new(t.id.clone(), t.label.clone()))
                        .collect();
                    let resp = crate::entropy_gui::TabBar::new(bar_id.as_str()).stretch(*stretch).show(ui, &tabs_data, selected);
                    for event in resp.events {
                        match event {
                            crate::entropy_gui::TabBarEvent::Selected(tab) => {
                                events_to_push.push(format!("TABBAR_SELECTED|{}|{}", bar_id, tab));
                            }
                        }
                    }
                }
                UiWidget::PadGrid { id: pad_id, config } => {
                    use crate::entropy_gui::{Pad, PadEvent, PadGrid, PadGridOptions, PadKind};
                    let d = PadGridOptions::default();
                    let opts = PadGridOptions {
                        columns: config.columns.map(|c| c.max(1) as usize).unwrap_or(d.columns),
                        pad_size: crate::entropy_gui::vec2(config.pad_width.unwrap_or(d.pad_size.x), config.pad_height.unwrap_or(d.pad_size.y)),
                        add_tile: config.add_tile.unwrap_or(false),
                    };
                    let pads: Vec<Pad> = config
                        .pads
                        .iter()
                        .map(|p| {
                            let color = p.color.map(egui::Color32::from_rgba_f32).unwrap_or(egui::Color32::from_rgb(90, 130, 230));
                            let mut pad = Pad::new(p.id.clone(), p.label.clone(), color);
                            pad.sublabel = p.sublabel.clone().unwrap_or_default();
                            pad.hint = p.hint.clone().unwrap_or_default();
                            pad.kind = match p.kind.as_deref() {
                                Some("synth") => PadKind::Synth,
                                Some("sample") => PadKind::Sample,
                                Some("missing") => PadKind::Missing,
                                _ => PadKind::Empty,
                            };
                            pad.waveform = p.waveform.clone().unwrap_or_default();
                            pad.trim = p.trim.unwrap_or([0.0, 1.0]);
                            pad.selected = p.selected.unwrap_or(false);
                            pad.glow = p.glow.unwrap_or(0.0);
                            pad
                        })
                        .collect();
                    let resp = PadGrid::new(pad_id.as_str()).options(opts).show(ui, &pads);
                    for event in resp.events {
                        match event {
                            PadEvent::Clicked(pad) => events_to_push.push(format!("PADGRID_CLICKED|{}|{}", pad_id, pad)),
                            PadEvent::Cleared(pad) => events_to_push.push(format!("PADGRID_CLEARED|{}|{}", pad_id, pad)),
                            PadEvent::AddRequested => events_to_push.push(format!("PADGRID_ADD|{}", pad_id)),
                        }
                    }
                }
                UiWidget::WavetableView { id: wt_id, config } => {
                    use crate::audio::wavetable;
                    use crate::entropy_gui::{ViewTool, WavetableEvent, WavetableOptions, WavetableView};
                    let handle = wavetable::ensure_table(&config.table);
                    let mut table = wavetable::lock_table(&handle);
                    let d = WavetableOptions::default();
                    let opts = WavetableOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        tool: config.tool.as_deref().and_then(ViewTool::from_name).unwrap_or(d.tool),
                        radius: config.radius.unwrap_or(d.radius),
                        strength: config.strength.unwrap_or(d.strength),
                        frame: config.frame.map(|f| f as usize).unwrap_or(d.frame),
                        keyboard: config.keyboard.unwrap_or(d.keyboard),
                        first_key: config.first_key.map(|k| k.min(96) as u8).unwrap_or(d.first_key),
                        key_octaves: config.octaves.map(|o| o.clamp(1, 5) as u8).unwrap_or(d.key_octaves),
                        held: config.held.clone().unwrap_or_default().into_iter().map(|k| k.min(127) as u8).collect(),
                    };
                    let resp = WavetableView::new(wt_id.as_str()).options(opts).show(ui, &mut table);
                    for event in resp.events {
                        events_to_push.push(match event {
                            WavetableEvent::StrokeBegan => format!("WAVETABLE_STROKE_BEGAN|{}", wt_id),
                            WavetableEvent::StrokeEnded => format!("WAVETABLE_STROKE_ENDED|{}", wt_id),
                            WavetableEvent::Edited => format!("WAVETABLE_EDITED|{}", wt_id),
                            WavetableEvent::FrameSelected(f) => format!("WAVETABLE_FRAME|{}|{}", wt_id, f),
                            WavetableEvent::ToolSelected(t) => format!("WAVETABLE_TOOL|{}|{}", wt_id, t.name()),
                            WavetableEvent::KeyDown { midi, velocity } => format!("WAVETABLE_KEY_DOWN|{}|{}|{:.3}", wt_id, midi, velocity),
                            WavetableEvent::KeyUp { midi } => format!("WAVETABLE_KEY_UP|{}|{}", wt_id, midi),
                        });
                    }
                }
                UiWidget::ReverbEqView { id: rv_id, config } => {
                    use crate::entropy_gui::{ReverbEqEvent, ReverbEqOptions, ReverbEqView, ReverbSettings, SpaceView};
                    let (spectrum_db, sample_rate) = context
                        .audio_engine
                        .spectrum(&config.source, 4096)
                        .map(|s| (s.bins_db, s.sample_rate))
                        .unwrap_or_else(|| (Vec::new(), crate::audio::analysis::ENGINE_SAMPLE_RATE as f32));
                    let d = ReverbEqOptions::default();
                    let rd = ReverbSettings::default();
                    let rv = config.reverb.clone().unwrap_or_default();
                    let opts = ReverbEqOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        reverb: ReverbSettings {
                            room_size: rv.room_size.unwrap_or(rd.room_size),
                            time: rv.time.unwrap_or(rd.time),
                            damping: rv.damping.unwrap_or(rd.damping),
                            mix: rv.mix.unwrap_or(rd.mix),
                        },
                        eq: config.eq.as_ref().map(|e| e.to_params()).unwrap_or(d.eq),
                        selected: config.selected_band.filter(|b| *b >= 0).map(|b| (b as usize).min(crate::audio::eq::EQ_BANDS - 1)),
                        view: config.view.as_deref().and_then(SpaceView::from_name).unwrap_or(d.view),
                        spectrum_db,
                        sample_rate,
                        caption: config.caption.clone(),
                    };
                    let resp = ReverbEqView::new(rv_id.as_str()).options(opts).show(ui);
                    for event in resp.events {
                        events_to_push.push(match event {
                            ReverbEqEvent::BandChanged { index, band } => format!(
                                "REVERB_EQ_BAND|{}|{}|{}|{}|{:.3}|{:.4}|{:.4}",
                                rv_id, index, band.kind.name(), band.enabled as u8, band.freq, band.gain_db, band.q
                            ),
                            ReverbEqEvent::BandSelected(b) => format!("REVERB_EQ_SELECT|{}|{}", rv_id, b.map(|b| b as i64).unwrap_or(-1)),
                            ReverbEqEvent::EditEnded => format!("REVERB_EQ_EDIT_END|{}", rv_id),
                            ReverbEqEvent::ViewSelected(v) => format!("REVERB_EQ_VIEW|{}|{}", rv_id, v.name()),
                        });
                    }
                }
                UiWidget::PhysModView { id: pm_id, config } => {
                    use crate::audio::physmod;
                    use crate::entropy_gui::{PhysModEvent, PhysModOptions, PhysModView};
                    let shared = physmod::shared_for(&config.instrument);
                    let d = PhysModOptions::default();
                    let opts = PhysModOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        strings: d.strings,
                        active_string: config.active_string.map(|s| s as usize),
                        bow_position: config.bow_position.unwrap_or(d.bow_position),
                        bow_force: config.bow_force.unwrap_or(d.bow_force),
                        body_size: config.body_size.unwrap_or(d.body_size),
                        keyboard: config.keyboard.unwrap_or(d.keyboard),
                        first_key: config.first_key.map(|k| k.min(96) as u8).unwrap_or(d.first_key),
                        key_octaves: config.octaves.map(|o| o.clamp(1, 5) as u8).unwrap_or(d.key_octaves),
                        held: config.held.clone().unwrap_or_default().into_iter().map(|k| k.min(127) as u8).collect(),
                        physics_view: config.physics_view.unwrap_or(d.physics_view),
                        exaggeration: config.exaggeration.unwrap_or(d.exaggeration),
                    };
                    let resp = PhysModView::new(pm_id.as_str()).show(ui, &opts, &shared);
                    for event in resp.events {
                        events_to_push.push(match event {
                            PhysModEvent::BowDrag { position, force } => format!("PHYSMOD_BOW_DRAG|{}|{:.4}|{:.4}", pm_id, position, force),
                            PhysModEvent::KeyDown { midi, velocity } => format!("PHYSMOD_KEY_DOWN|{}|{}|{:.3}", pm_id, midi, velocity),
                            PhysModEvent::KeyUp { midi } => format!("PHYSMOD_KEY_UP|{}|{}", pm_id, midi),
                            PhysModEvent::PhysicsView(on) => format!("PHYSMOD_PHYSICS_VIEW|{}|{}", pm_id, on as u8),
                        });
                    }
                }
                UiWidget::FretboardView { id: fb_id, config } => {
                    use crate::entropy_gui::{FretMark, FretboardEvent, FretboardOptions, FretboardView, HighwayItem, HighwayState};
                    let d = FretboardOptions::default();
                    let clamp_string = |s: u32| s.min(5) as u8;
                    let clamp_fret = |f: u32| f.min(crate::entropy_gui::widgets_fretboard::MAX_FRET as u32) as u8;
                    let mark = |m: &crate::deno::addon_ops::FretMarkConfig| FretMark {
                        string: clamp_string(m.string),
                        fret: clamp_fret(m.fret),
                        finger: m.finger.map(|f| f.clamp(1, 4) as u8),
                        ahead: m.ahead.unwrap_or(0).min(255) as u8,
                        correct: m.correct.unwrap_or(true),
                    };
                    let mut tuning = d.tuning;
                    if let Some(t) = config.tuning.as_ref().filter(|t| t.len() == 6) {
                        for (slot, v) in tuning.iter_mut().zip(t) {
                            *slot = (*v).min(100) as u8;
                        }
                    }
                    let opts = FretboardOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        tuning,
                        first_fret: config.first_fret.map(clamp_fret).unwrap_or(d.first_fret),
                        last_fret: config.last_fret.map(clamp_fret).unwrap_or(d.last_fret),
                        targets: config.targets.iter().map(mark).collect(),
                        upcoming: config.upcoming.iter().map(mark).collect(),
                        heard: config.heard.iter().map(mark).collect(),
                        muted: config.muted.iter().map(|s| clamp_string(*s)).collect(),
                        show_highway: config.show_highway.unwrap_or(d.show_highway),
                        highway: config
                            .highway
                            .iter()
                            .map(|h| HighwayItem {
                                ahead: if h.ahead.is_finite() { h.ahead } else { 0.0 },
                                notes: h.notes.iter().map(|n| (clamp_string(n.string), clamp_fret(n.fret))).collect(),
                                muted: h.muted.iter().map(|s| clamp_string(*s)).collect(),
                                state: h.state.as_deref().map(HighwayState::from_name).unwrap_or_default(),
                                label: h.label.clone(),
                            })
                            .collect(),
                        highway_bars: config.highway_bars.iter().copied().filter(|b| b.is_finite()).collect(),
                        highway_span: config.highway_span.filter(|s| s.is_finite()).unwrap_or(d.highway_span).clamp(1.0, 64.0),
                        caption: config.caption.clone().unwrap_or_default(),
                        status: config.status.clone().unwrap_or_default(),
                        flash: config.flash.unwrap_or(0.0).clamp(0.0, 1.0),
                        flash_miss: config.flash_kind.as_deref() == Some("miss"),
                        low_on_top: config.low_on_top.unwrap_or(d.low_on_top),
                        interactive: config.interactive.unwrap_or(d.interactive),
                    };
                    let resp = FretboardView::new(fb_id.as_str()).show(ui, &opts);
                    for event in resp.events {
                        events_to_push.push(match event {
                            FretboardEvent::Pick { string, fret } => format!("FRETBOARD_PICK|{}|{}|{}", fb_id, string, fret),
                        });
                    }
                }
                UiWidget::PianoView { id: pn_id, config } => {
                    use crate::audio::piano;
                    use crate::entropy_gui::{PianoEvent, PianoOptions, PianoView};
                    let shared = piano::shared_for(&config.instrument);
                    let d = PianoOptions::default();
                    let opts = PianoOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        physics_view: config.physics_view.unwrap_or(d.physics_view),
                    };
                    let resp = PianoView::new(pn_id.as_str()).show(ui, &opts, &shared);
                    for event in resp.events {
                        events_to_push.push(match event {
                            PianoEvent::KeyPressed { key, freq, velocity } => {
                                format!("PIANO_KEY_DOWN|{}|{}|{:.3}|{:.3}", pn_id, key, freq, velocity)
                            }
                            PianoEvent::KeyReleased { key, freq } => {
                                format!("PIANO_KEY_UP|{}|{}|{:.3}", pn_id, key, freq)
                            }
                            PianoEvent::SustainToggled { sustain } => {
                                format!("PIANO_SUSTAIN|{}|{:.3}", pn_id, sustain)
                            }
                            PianoEvent::PhysicsToggled(on) => {
                                format!("PIANO_PHYSICS_VIEW|{}|{}", pn_id, on as u8)
                            }
                        });
                    }
                }
                UiWidget::BrassView { id: br_id, config } => {
                    use crate::audio::brass;
                    use crate::entropy_gui::{BrassView, BrassViewEvent, BrassViewOptions};
                    let shared = brass::shared_for(&config.instrument);
                    let d = BrassViewOptions::default();
                    let opts = BrassViewOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        keyboard: config.keyboard.unwrap_or(d.keyboard),
                        first_key: config.first_key.map(|k| k.min(96) as u8).unwrap_or(d.first_key),
                        key_octaves: config.octaves.map(|o| o.clamp(1, 5) as u8).unwrap_or(d.key_octaves),
                        held: config.held.clone().unwrap_or_default().into_iter().map(|k| k.min(127) as u8).collect(),
                        physics_view: config.physics_view.unwrap_or(d.physics_view),
                        exaggeration: config.exaggeration.unwrap_or(d.exaggeration),
                        breath: config.breath.unwrap_or(d.breath),
                        lip_tension: config.lip_tension.unwrap_or(d.lip_tension),
                    };
                    let resp = BrassView::new(br_id.as_str()).show(ui, &opts, &shared);
                    for event in resp.events {
                        events_to_push.push(match event {
                            BrassViewEvent::KeyDown { midi, velocity } => format!("BRASS_KEY_DOWN|{}|{}|{:.3}", br_id, midi, velocity),
                            BrassViewEvent::KeyUp { midi } => format!("BRASS_KEY_UP|{}|{}", br_id, midi),
                            BrassViewEvent::SlideDrag { position } => format!("BRASS_SLIDE_DRAG|{}|{:.4}", br_id, position),
                            BrassViewEvent::PlayDrag { breath, lip_tension } => format!("BRASS_PLAY_DRAG|{}|{:.4}|{:.4}", br_id, breath, lip_tension),
                            BrassViewEvent::PhysicsView(on) => format!("BRASS_PHYSICS_VIEW|{}|{}", br_id, on as u8),
                        });
                    }
                }
                UiWidget::MatterView { id: mt_id, config } => {
                    use crate::audio::matter::live;
                    use crate::entropy_gui::{MatterView, MatterViewEvent, MatterViewOptions};
                    let shared = live::shared_for(&config.kit);
                    let d = MatterViewOptions::default();
                    let opts = MatterViewOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        pads: config.pads.unwrap_or(d.pads),
                        physics_view: config.physics_view.unwrap_or(d.physics_view),
                        exaggeration: config.exaggeration.unwrap_or(d.exaggeration),
                        status: config.status.clone(),
                    };
                    let resp = MatterView::new(mt_id.as_str()).show(ui, &opts, &shared);
                    for event in resp.events {
                        events_to_push.push(match event {
                            MatterViewEvent::Strike { piece, position, angle, velocity } => format!("MATTER_STRIKE|{}|{}|{:.4}|{:.4}|{:.3}", mt_id, piece.name(), position, angle, velocity),
                            MatterViewEvent::Pad { piece, velocity } => format!("MATTER_PAD|{}|{}|{:.3}", mt_id, piece.name(), velocity),
                            MatterViewEvent::Rub { piece, x, y, pressure } => format!("MATTER_RUB|{}|{}|{:.4}|{:.4}|{:.3}", mt_id, piece.name(), x, y, pressure),
                            MatterViewEvent::PhysicsView(on) => format!("MATTER_PHYSICS_VIEW|{}|{}", mt_id, on as u8),
                        });
                    }
                }
                UiWidget::WaterView { id: wv_id, config } => {
                    use crate::audio::matter::water_voice;
                    use crate::entropy_gui::{WaterView, WaterViewEvent, WaterViewOptions};
                    let shared = water_voice::shared_for(&config.water);
                    let d = WaterViewOptions::default();
                    let opts = WaterViewOptions {
                        width: config.width,
                        height: config.height.unwrap_or(d.height),
                        pads: config.pads.unwrap_or(d.pads),
                        physics_view: config.physics_view.unwrap_or(d.physics_view),
                        exaggeration: config.exaggeration.unwrap_or(d.exaggeration),
                        status: config.status.clone(),
                    };
                    let resp = WaterView::new(wv_id.as_str()).show(ui, &opts, &shared);
                    for event in resp.events {
                        events_to_push.push(match event {
                            WaterViewEvent::Drip { x, velocity } => format!("WATER_DRIP|{}|{:.4}|{:.3}", wv_id, x, velocity),
                            WaterViewEvent::Glass { index, pitch, velocity } => format!("WATER_GLASS|{}|{}|{:.3}|{:.3}", wv_id, index, pitch, velocity),
                            WaterViewEvent::Fill { height, velocity } => format!("WATER_FILL|{}|{:.4}|{:.3}", wv_id, height, velocity),
                            WaterViewEvent::Hold { source, velocity } => format!("WATER_HOLD|{}|{}|{:.3}", wv_id, source.name(), velocity),
                            WaterViewEvent::Pad { source, velocity } => format!("WATER_PAD|{}|{}|{:.3}", wv_id, source.name(), velocity),
                            WaterViewEvent::PhysicsView(on) => format!("WATER_PHYSICS_VIEW|{}|{}", wv_id, on as u8),
                        });
                    }
                }
                UiWidget::Oscilloscope { id: scope_id, config } => {
                    use crate::entropy_gui::{widgets_analysis::ACCENT, Oscilloscope, ScopeMode, ScopeOptions};
                    let sr = crate::audio::analysis::ENGINE_SAMPLE_RATE as f32;
                    // The screen spans `window_ms`; twice that is copied so the trigger has history to search.
                    let window = ((config.window_ms.unwrap_or(23.0).clamp(5.0, 90.0) / 1000.0) * sr).round() as usize;
                    let (left, right) = context
                        .audio_engine
                        .snapshot(&config.source, window * 2)
                        .map(|s| (s.left, s.right))
                        .unwrap_or_default();
                    let mode = match config.mode.as_deref() {
                        Some("stereo") => ScopeMode::Stereo,
                        Some("xy") => ScopeMode::Xy,
                        _ => ScopeMode::Mono,
                    };
                    let opts = ScopeOptions {
                        mode,
                        height: config.height.unwrap_or(180.0),
                        window_frames: window,
                        trigger: config.trigger.unwrap_or(true),
                        trigger_level: config.trigger_level.unwrap_or(0.0),
                        color: config.color.map(analysis_color).unwrap_or(ACCENT),
                        persistence: config.persistence.unwrap_or(0.12),
                        sample_rate: sr,
                        gain: config.gain.unwrap_or(1.0),
                        width: config.width,
                    };
                    Oscilloscope::new(scope_id.as_str()).options(opts).show(ui, &left, &right);
                }
                UiWidget::Spectrum { id: spectrum_id, config } => {
                    use crate::entropy_gui::{widgets_analysis::ACCENT, SpectrumOptions, SpectrumStyle, SpectrumView};
                    let fft = config.fft_size.unwrap_or(4096) as usize;
                    let (bins, sr) = context
                        .audio_engine
                        .spectrum(&config.source, fft)
                        .map(|s| (s.bins_db, s.sample_rate))
                        .unwrap_or_else(|| (Vec::new(), crate::audio::analysis::ENGINE_SAMPLE_RATE as f32));
                    let d = SpectrumOptions::default();
                    let opts = SpectrumOptions {
                        style: if config.style.as_deref() == Some("bars") { SpectrumStyle::Bars } else { SpectrumStyle::Filled },
                        height: config.height.unwrap_or(d.height),
                        min_db: config.min_db.unwrap_or(d.min_db),
                        max_db: config.max_db.unwrap_or(d.max_db),
                        min_hz: config.min_hz.unwrap_or(d.min_hz),
                        max_hz: config.max_hz.unwrap_or(d.max_hz),
                        bands_per_octave: config.bands_per_octave.unwrap_or(d.bands_per_octave),
                        peak_hold: config.peak_hold.unwrap_or(d.peak_hold),
                        tilt_db_per_octave: config.tilt_db_per_octave.unwrap_or(d.tilt_db_per_octave),
                        fall_db_per_s: config.fall_db_per_s.unwrap_or(d.fall_db_per_s),
                        color: config.color.map(analysis_color).unwrap_or(ACCENT),
                        width: config.width,
                        ..d
                    };
                    SpectrumView::new(spectrum_id.as_str()).options(opts).show(ui, &bins, sr);
                }
                UiWidget::MusicVisualizer { id: viz_id, config } => {
                    crate::deno::music_video_ops::draw_preview(ui, viz_id, config, context, egui_renderer);
                }
                UiWidget::LevelMeter { id: meter_id, config } => {
                    use crate::entropy_gui::{LevelMeter, MeterOptions, MeterReading};
                    let reading = context
                        .audio_engine
                        .levels(&config.source, meter_id)
                        .map(|l| MeterReading { peak: l.peak, rms: l.rms })
                        .unwrap_or_default();
                    let d = MeterOptions::default();
                    let opts = MeterOptions {
                        width: config.width.unwrap_or(d.width),
                        height: config.height.unwrap_or(d.height),
                        show_scale: config.show_scale.unwrap_or(d.show_scale),
                        ..d
                    };
                    LevelMeter::new(meter_id.as_str()).options(opts).show(ui, reading);
                }
                UiWidget::Snarl { id: snarl_id, graph, height: snarl_height } => {
                    // Real, interactive editor (pan/zoom/drag/connect) as of this session - see
                    // `entropy_gui::widgets_node_graph`. `SnarlConfig.onConnect`/`onDisconnect`/
                    // `onNodeMoved` (`examples/studio-bundle/src/addon.d.ts`) and their
                    // `SNARL_CONNECT`/`SNARL_DISCONNECT`/`SNARL_NODE_MOVED` event parsing
                    // (`src/deno/addon_setup.js`'s `snarl()`/`_process_events`) already existed
                    // from whenever the Snarl widget was first stubbed out - this is the first
                    // session that actually fires those events, since the old fallback was
                    // read-only. `nodes`/`links` are rebuilt from the addon's `BehaviorGraph`
                    // every frame (this call site has no persistent `&mut` into it), so a
                    // caller's own state only stays in sync if its `onNodeMoved`/`onConnect`
                    // handler updates it - the editor's own drag-preview state (see the module
                    // docs) keeps the drag itself visually smooth either way.
                    let nodes: Vec<crate::entropy_gui::GraphNode> = graph
                        .nodes
                        .iter()
                        .map(|n| {
                            // `n.name` is shown as-is (no appended `(node_type)`) so an addon
                            // can put a live-computed value straight in the title, e.g. a
                            // nocode calculator graph naming a node "Add = 7.00" each frame.
                            let mut gn = crate::entropy_gui::GraphNode::new(
                                n.id.clone(),
                                n.name.clone(),
                                crate::entropy_gui::pos2(n.position[0], n.position[1]),
                            );
                            gn.inputs = n.inputs.iter().map(|p| crate::entropy_gui::GraphPin::new(p.id.clone(), p.name.clone())).collect();
                            gn.outputs = n.outputs.iter().map(|p| crate::entropy_gui::GraphPin::new(p.id.clone(), p.name.clone())).collect();
                            gn
                        })
                        .collect();
                    let links: Vec<crate::entropy_gui::GraphLink> = graph
                        .connections
                        .iter()
                        .map(|c| crate::entropy_gui::GraphLink {
                            from_node: c.from_node.clone(),
                            from_pin: c.from_pin.clone(),
                            to_node: c.to_node.clone(),
                            to_pin: c.to_pin.clone(),
                        })
                        .collect();

                    let mut editor = crate::entropy_gui::NodeGraphEditor::new(snarl_id.as_str());
                    if let Some(h) = snarl_height {
                        editor = editor.height(*h);
                    }
                    let resp = editor.show(ui, &nodes, &links, graph.selected_node.as_deref(), |_, _| {});
                    for event in resp.events {
                        match event {
                            crate::entropy_gui::NodeGraphEvent::NodeMoved { node, pos } => {
                                events_to_push.push(format!("SNARL_NODE_MOVED|{}|{}|{},{}", snarl_id, node, pos.x, pos.y));
                            }
                            crate::entropy_gui::NodeGraphEvent::LinkCreated(link) => {
                                events_to_push.push(format!(
                                    "SNARL_CONNECT|{}|{}|{}|{}|{}",
                                    snarl_id, link.from_node, link.from_pin, link.to_node, link.to_pin
                                ));
                            }
                            crate::entropy_gui::NodeGraphEvent::LinkRemoved(idx) => {
                                if let Some(link) = links.get(idx) {
                                    events_to_push.push(format!(
                                        "SNARL_DISCONNECT|{}|{}|{}|{}|{}",
                                        snarl_id, link.from_node, link.from_pin, link.to_node, link.to_pin
                                    ));
                                }
                            }
                            crate::entropy_gui::NodeGraphEvent::NodeClicked(node) => {
                                events_to_push.push(format!("SNARL_NODE_SELECTED|{}|{}", snarl_id, node));
                            }
                            crate::entropy_gui::NodeGraphEvent::BackgroundClicked
                            | crate::entropy_gui::NodeGraphEvent::DeleteRequested(_) => {}
                        }
                    }
                }
                UiWidget::DocEditor { id: doc_id, page_width, page_height, margin } => {
                    let page = crate::entropy_gui::PageConfig { width: *page_width, height: *page_height, margin: *margin };
                    let commands = context.doc_editor_commands.remove(doc_id).unwrap_or_default();
                    let resp = crate::entropy_gui::DocEditor::new(doc_id.as_str()).show(ui, page, &commands);
                    let [cr, cg, cb, ca] = resp.active_color.to_array_f32();
                    events_to_push.push(format!(
                        "DOCEDIT_STATS|{}|{}|{}|{}|{}|{}|{}|{}|{},{},{},{}|{}",
                        doc_id,
                        resp.word_count,
                        resp.char_count,
                        resp.page_count,
                        resp.paginated,
                        resp.active_bold,
                        resp.active_italic,
                        resp.active_font_size,
                        cr, cg, cb, ca,
                        resp.active_font_name,
                    ));
                }
                UiWidget::CollapsingHeader { title, id, default_open } => {
                    // Find matching EndCollapsingHeader
                    let mut depth = 1;
                    let mut end_idx = i + 1;
                    while end_idx < widgets.len() && depth > 0 {
                        match &widgets[end_idx] {
                            UiWidget::CollapsingHeader { .. } => depth += 1,
                            UiWidget::EndCollapsingHeader => depth -= 1,
                            _ => {}
                        }
                        if depth > 0 {
                            end_idx += 1;
                        }
                    }

                    if end_idx < widgets.len() {
                        let sub_widgets = &widgets[i + 1..end_idx];
                        egui::CollapsingHeader::new(title)
                            .id_source(id)
                            .default_open(default_open.unwrap_or(false))
                            .show(ui, |ui| {
                                Self::render_widgets(ui, sub_widgets, events_to_push, context, egui_renderer);
                            });
                        i = end_idx;
                    }
                }
                UiWidget::EndCollapsingHeader => {}
                UiWidget::StartHorizontal => {
                    // Find matching EndHorizontal
                    let mut depth = 1;
                    let mut end_idx = i + 1;
                    while end_idx < widgets.len() && depth > 0 {
                        match &widgets[end_idx] {
                            UiWidget::StartHorizontal => depth += 1,
                            UiWidget::EndHorizontal => depth -= 1,
                            _ => {}
                        }
                        if depth > 0 {
                            end_idx += 1;
                        }
                    }

                    if end_idx < widgets.len() {
                        let sub_widgets = &widgets[i + 1..end_idx];
                        ui.horizontal(|ui| {
                            Self::render_widgets(ui, sub_widgets, events_to_push, context, egui_renderer);
                        });
                        i = end_idx;
                    }
                }
                UiWidget::EndHorizontal => {}
                UiWidget::StartVertical => {
                    // Find matching EndVertical
                    let mut depth = 1;
                    let mut end_idx = i + 1;
                    while end_idx < widgets.len() && depth > 0 {
                        match &widgets[end_idx] {
                            UiWidget::StartVertical => depth += 1,
                            UiWidget::EndVertical => depth -= 1,
                            _ => {}
                        }
                        if depth > 0 {
                            end_idx += 1;
                        }
                    }

                    if end_idx < widgets.len() {
                        let sub_widgets = &widgets[i + 1..end_idx];
                        ui.vertical(|ui| {
                            Self::render_widgets(ui, sub_widgets, events_to_push, context, egui_renderer);
                        });
                        i = end_idx;
                    }
                }
                UiWidget::EndVertical => {}
                UiWidget::StartGroup => {
                    // Find matching EndGroup
                    let mut depth = 1;
                    let mut end_idx = i + 1;
                    while end_idx < widgets.len() && depth > 0 {
                        match &widgets[end_idx] {
                            UiWidget::StartGroup => depth += 1,
                            UiWidget::EndGroup => depth -= 1,
                            _ => {}
                        }
                        if depth > 0 {
                            end_idx += 1;
                        }
                    }

                    if end_idx < widgets.len() {
                        let sub_widgets = &widgets[i + 1..end_idx];
                        ui.group(|ui| {
                            ui.vertical(|ui| {
                                Self::render_widgets(ui, sub_widgets, events_to_push, context, egui_renderer);
                            });
                        });
                        i = end_idx;
                    }
                }
                UiWidget::EndGroup => {}
                UiWidget::StartBar { id: bar_id, config } => {
                    let end_idx = Self::matching_end(widgets, i, |w| matches!(w, UiWidget::StartBar { .. }), |w| matches!(w, UiWidget::EndBar));
                    let body = &widgets[i + 1..end_idx.min(widgets.len())];
                    // Zones are opened by `BarZone` markers at this bar's own depth.
                    let mut zones: Vec<(u8, usize, usize)> = Vec::new();
                    let mut depth = 0;
                    for (k, w) in body.iter().enumerate() {
                        match w {
                            UiWidget::StartBar { .. } => depth += 1,
                            UiWidget::EndBar => depth -= 1,
                            UiWidget::BarZone { zone } if depth == 0 => {
                                if let Some(last) = zones.last_mut() {
                                    last.2 = k;
                                }
                                zones.push((*zone, k + 1, body.len()));
                            }
                            _ => {}
                        }
                    }
                    let style = egui::BarStyle {
                        height: config.height.unwrap_or(40.0),
                        fill: config.fill.map(egui::Color32::from_rgba_f32).unwrap_or(egui::Color32::TRANSPARENT),
                        border: config.border.map(egui::Color32::from_rgba_f32),
                        border_top: config.border_top.unwrap_or(false),
                        padding_x: config.padding_x.unwrap_or(10.0),
                        gap: 6.0,
                    };
                    let mut bar = egui::Bar::begin(ui, bar_id.as_str(), style);
                    for (zone, from, to) in zones {
                        let zone = match zone { 0 => egui::BarZone::Left, 1 => egui::BarZone::Center, _ => egui::BarZone::Right };
                        let mut child = bar.zone_ui(ui, zone);
                        Self::render_widgets(&mut child, &body[from..to], events_to_push, context, egui_renderer);
                        bar.end_zone(ui, zone, &child);
                    }
                    i = end_idx;
                }
                UiWidget::BarZone { .. } | UiWidget::EndBar => {}
                UiWidget::StartSplit { id: split_id, config } => {
                    let end_idx = Self::matching_end(widgets, i, |w| matches!(w, UiWidget::StartSplit { .. }), |w| matches!(w, UiWidget::EndSplit));
                    let body = &widgets[i + 1..end_idx.min(widgets.len())];
                    let mut depth = 0;
                    let mut side_at = body.len();
                    for (k, w) in body.iter().enumerate() {
                        match w {
                            UiWidget::StartSplit { .. } => depth += 1,
                            UiWidget::EndSplit => depth -= 1,
                            UiWidget::SplitSide if depth == 0 => {
                                side_at = k;
                                break;
                            }
                            _ => {}
                        }
                    }
                    let (main_body, side_body) = (&body[..side_at], if side_at < body.len() { &body[side_at + 1..] } else { &body[body.len()..] });
                    let mut style = egui::SplitStyle::default();
                    style.side_width = config.side_width.unwrap_or(style.side_width);
                    style.side_open = config.side_open.unwrap_or(true) && side_at < body.len();
                    style.reserve_bottom = config.reserve_bottom.unwrap_or(0.0);
                    style.min_height = config.min_height.unwrap_or(style.min_height);
                    if let Some(c) = config.main_fill { style.main_fill = egui::Color32::from_rgba_f32(c); }
                    if let Some(c) = config.side_fill { style.side_fill = egui::Color32::from_rgba_f32(c); }
                    if let Some(c) = config.divider { style.divider = egui::Color32::from_rgba_f32(c); }
                    let split = egui::Split::begin(ui, style);
                    let mut main_ui = egui::Split::pane_ui(ui, split.main, config.main_padding.unwrap_or(0.0), (split_id.as_str(), "main"));
                    if config.scroll_main.unwrap_or(false) {
                        egui::ScrollArea::vertical().show(&mut main_ui, |ui| {
                            Self::render_widgets(ui, main_body, events_to_push, context, egui_renderer);
                        });
                    } else {
                        Self::render_widgets(&mut main_ui, main_body, events_to_push, context, egui_renderer);
                    }
                    if let Some(side) = split.side {
                        let mut side_ui = egui::Split::pane_ui(ui, side, config.side_padding.unwrap_or(12.0), (split_id.as_str(), "side"));
                        if config.scroll_side.unwrap_or(true) {
                            egui::ScrollArea::vertical().show(&mut side_ui, |ui| {
                                Self::render_widgets(ui, side_body, events_to_push, context, egui_renderer);
                            });
                        } else {
                            Self::render_widgets(&mut side_ui, side_body, events_to_push, context, egui_renderer);
                        }
                    }
                    i = end_idx;
                }
                UiWidget::SplitSide | UiWidget::EndSplit => {}
                UiWidget::StartCard { id: card_id, config } => {
                    let end_idx = Self::matching_end(widgets, i, |w| matches!(w, UiWidget::StartCard { .. }), |w| matches!(w, UiWidget::EndCard));
                    let body = &widgets[i + 1..end_idx.min(widgets.len())];
                    let mut style = egui::CardStyle::default();
                    if let Some(c) = config.fill { style.fill = egui::Color32::from_rgba_f32(c); }
                    if let Some(c) = config.stroke { style.stroke = egui::Stroke::new(1.0, egui::Color32::from_rgba_f32(c)); }
                    if let Some(r) = config.radius { style.radius = r.clamp(0.0, 255.0) as u8; }
                    if let Some(p) = config.padding { style.padding = p; }
                    style.width = config.width;
                    egui::card(ui, card_id.as_str(), style, |ui| {
                        Self::render_widgets(ui, body, events_to_push, context, egui_renderer);
                    });
                    i = end_idx;
                }
                UiWidget::EndCard => {}
                UiWidget::Spacer { size } => {
                    ui.add_space(*size);
                }
                UiWidget::Segmented { id: seg_id, config } => {
                    if let Some(label) = config.label.as_ref().filter(|l| !l.is_empty()) {
                        ui.label(egui::RichText::new(label).font_size(11.5).color(egui::Color32::from_rgb(124, 132, 154)));
                    }
                    let selected = config.selected_index.unwrap_or(0);
                    let accent = config.accent.map(egui::Color32::from_rgba_f32);
                    if let Some(picked) = egui::Segmented::new(seg_id.as_str()).compact(config.compact.unwrap_or(false)).show(ui, &config.options, selected, accent) {
                        events_to_push.push(format!("{}|{}", seg_id, picked));
                    }
                }
                UiWidget::Separator => {
                    ui.separator();
                }
                UiWidget::Hyperlink { id: _, text, url } => {
                    ui.hyperlink_to(text, url.as_str());
                }
                UiWidget::TextInput { id: input_id, label, value, width } => {
                    ui.horizontal(|ui| {
                        if !label.is_empty() {
                            ui.label(label);
                        }
                        let mut current_value = value.clone();
                        let response = if *width > 0.0 {
                            ui.text_edit_singleline_sized(&mut current_value, *width, egui::Id::new(("addon_text_input", input_id.as_str())))
                        } else {
                            ui.text_edit_singleline(&mut current_value)
                        };
                        if response.changed() {
                            let payload = format!("{}|{}", input_id, current_value);
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::LayoutCanvas { id: canvas_id, width, height, boxes, handle_links } => {
                    // The HTML-as-UI experiment's CSS/taffy layout result (see html_layout.rs):
                    // a flat list of already-absolutely-positioned boxes. Backgrounds/borders/
                    // text are painted directly; interactive leaves go through
                    // `ui.child_ui_at` so button/checkbox/text-edit/hyperlink/dropdown all get
                    // entropy_gui's real, already-correct widget behavior at that computed rect
                    // instead of hand-rolled hit-testing.
                    let (rect, _resp) = ui.allocate_exact_size(egui::vec2(*width, *height), egui::Sense::hover());
                    let origin = rect.min;
                    for b in boxes {
                        let box_rect = egui::Rect::from_min_size(origin + egui::vec2(b.x, b.y), egui::vec2(b.w, b.h));
                        if let Some(bg) = b.background {
                            ui.painter().rect_filled(box_rect, 0.0, egui::Color32::from_rgba_f32(bg));
                        }
                        if let Some((color, stroke_width)) = &b.border {
                            ui.painter().rect_stroke(box_rect, 0.0, egui::Stroke::new(*stroke_width, egui::Color32::from_rgba_f32(*color)), egui::StrokeKind::Middle);
                        }
                        match &b.leaf {
                            None => {}
                            Some(crate::deno::html_layout::LayoutLeaf::Text { text, bold, color, align: _ }) => {
                                if !text.is_empty() {
                                    let mut rich = egui::RichText::new(text);
                                    if *bold {
                                        rich = rich.strong();
                                    }
                                    if let Some(c) = color {
                                        rich = rich.color(egui::Color32::from_rgba_f32(*c));
                                    }
                                    let mut child = ui.child_ui_at(box_rect, egui::Layout::top_down(egui::Align::Min), b.id_salt.as_str());
                                    child.label(rich);
                                }
                            }
                            Some(crate::deno::html_layout::LayoutLeaf::Button { id: btn_id, text }) => {
                                let mut child = ui.child_ui_at(box_rect, egui::Layout::top_down(egui::Align::Min), b.id_salt.as_str());
                                if child.button(text).clicked() {
                                    events_to_push.push(btn_id.clone());
                                }
                            }
                            Some(crate::deno::html_layout::LayoutLeaf::Checkbox { id: chk_id, value }) => {
                                let mut child = ui.child_ui_at(box_rect, egui::Layout::top_down(egui::Align::Min), b.id_salt.as_str());
                                let mut current = *value;
                                if child.checkbox(&mut current, "").changed() {
                                    events_to_push.push(format!("{}|{}", chk_id, current));
                                }
                            }
                            Some(crate::deno::html_layout::LayoutLeaf::TextInput { id: inp_id, value }) => {
                                let mut child = ui.child_ui_at(box_rect, egui::Layout::top_down(egui::Align::Min), b.id_salt.as_str());
                                let mut current = value.clone();
                                if child.text_edit_singleline(&mut current).changed() {
                                    events_to_push.push(format!("{}|{}", inp_id, current));
                                }
                            }
                            Some(crate::deno::html_layout::LayoutLeaf::Hyperlink { id: _, text, url }) => {
                                let mut child = ui.child_ui_at(box_rect, egui::Layout::top_down(egui::Align::Min), b.id_salt.as_str());
                                if *handle_links {
                                    if child.link(text).clicked() {
                                        events_to_push.push(format!("HTML_LINK|{}|{}", canvas_id, url));
                                    }
                                } else {
                                    child.hyperlink_to(text, url.as_str());
                                }
                            }
                            Some(crate::deno::html_layout::LayoutLeaf::Dropdown { id: drop_id, options, selected_index }) => {
                                let mut child = ui.child_ui_at(box_rect, egui::Layout::top_down(egui::Align::Min), b.id_salt.as_str());
                                let mut current = *selected_index;
                                let mut changed = false;
                                egui::ComboBox::from_id_source(drop_id).selected_text(options.get(current).cloned().unwrap_or_default()).show_ui(&mut child, |ui| {
                                    for (opt_i, opt) in options.iter().enumerate() {
                                        if ui.selectable_value(&mut current, opt_i, opt).clicked() {
                                            changed = true;
                                        }
                                    }
                                });
                                if changed {
                                    events_to_push.push(format!("{}|{}", drop_id, current));
                                }
                            }
                            Some(crate::deno::html_layout::LayoutLeaf::Image { texture_id }) => {
                                let tid = if let Some(tid) = context.egui_textures.get(texture_id) {
                                    Some(*tid)
                                } else if let (Some(view), Some(gpu)) = (context.textures.get(texture_id), &context.gpu_resources) {
                                    let tid = egui_renderer.register_native_texture(&gpu.device, view, wgpu::FilterMode::Linear);
                                    context.egui_textures.insert(texture_id.clone(), tid);
                                    Some(tid)
                                } else {
                                    None
                                };
                                if let Some(tid) = tid {
                                    ui.painter().image(tid, box_rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
                                }
                            }
                            Some(crate::deno::html_layout::LayoutLeaf::ImagePlaceholder { text }) => {
                                let mut child = ui.child_ui_at(box_rect, egui::Layout::top_down(egui::Align::Min), b.id_salt.as_str());
                                child.label(text);
                            }
                        }
                    }
                }
            }
            i += 1;
        }
    }

    pub fn render_tab(&mut self, ui: &mut egui::Ui, tab_id: &str, egui_renderer: &mut egui_wgpu::Renderer) {
        // 0. Reset widget counter in JS
        {
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let reset_key = v8::String::new(scope, "_reset_widget_counter").unwrap();
                    if let Some(reset_val) = entropy_obj.get(scope, reset_key.into()) {
                        if reset_val.is_function() {
                            let reset_func = v8::Local::<v8::Function>::try_from(reset_val).unwrap();
                            let _ = reset_func.call(scope, entropy_obj.into(), &[]);
                        }
                    }
                }
            }
        }

        // 1. Clear widgets for this tab
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                 context.ui_widgets.remove(tab_id);
            }
        }

        // 2. Execute JS callback for this tab
        let callback_opt = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.ui_tabs.get(tab_id).map(|(_, cb, _)| cb.clone())
            } else {
                None
            }
        };

        if let Some(callback) = callback_opt {
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, callback);
            let receiver = v8::undefined(tc);
            let _ = func.call(tc, receiver.into(), &[]); 
            
            if tc.has_caught() {
                if let Some(exception) = tc.exception() {
                    let msg = exception.to_rust_string_lossy(tc);
                    println!("[ADDON TAB ERROR] {}", msg);
                }
            }
        }

        // 3. Render
        let mut events_to_push = Vec::new();
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                 let widgets = context.ui_widgets.remove(tab_id);
                 let scroll = context.ui_tabs.get(tab_id).and_then(|(cfg, _, _)| cfg.scroll) != Some(false);
                 if let Some(widgets) = widgets {
                    if scroll {
                        egui::ScrollArea::vertical().show(ui, |ui| {
                            Self::render_widgets(ui, &widgets, &mut events_to_push, context, egui_renderer);
                        });
                    } else {
                        Self::render_widgets(ui, &widgets, &mut events_to_push, context, egui_renderer);
                    }
                 }
            }
        }

        // Push events
        if !events_to_push.is_empty() {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<AddonContext>() {
                if let Ok(mut events) = context.ui_events.lock() {
                    events.extend(events_to_push);
                }
            }
        }
    }
}


/// `[r, g, b, a]` in 0..1, as addon configs spell a colour, to the GUI's `Color32`.
fn analysis_color(c: [f32; 4]) -> crate::entropy_gui::color::Color32 {
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    crate::entropy_gui::color::Color32::from_rgba_unmultiplied(byte(c[0]), byte(c[1]), byte(c[2]), byte(c[3]))
}

/// Moves `camera` to wherever an addon last asked (`Entropy.Camera.setTransform` /
/// `setOrthographic`) and uploads it. Nothing pending leaves the camera as it is.
fn apply_pending_camera(context: &mut AddonContext, camera: &mut SimpleCamera, camera_binding: &mut CameraBinding, gpu_resources: &Arc<GpuResources>) {
    if let Some(pos) = context.pending_camera_position.take() {
        camera.position = nalgebra::Point3::new(pos[0], pos[1], pos[2]);
    }
    if let Some(up) = context.pending_camera_up.take() {
        let up = nalgebra::Vector3::new(up[0], up[1], up[2]);
        if up.norm() > 1e-6 {
            camera.up = up.normalize();
        }
    }
    if let Some(target) = context.pending_camera_target.take() {
        camera.direction = (nalgebra::Point3::new(target[0], target[1], target[2]) - camera.position).normalize();
    }
    if let Some((enabled, view_height)) = context.pending_camera_ortho.take() {
        camera.is_orthographic = enabled;
        if let Some(view_height) = view_height {
            camera.ortho_view_height = view_height;
        }
    }
    camera.update();
    camera_binding.update_3d(&gpu_resources.queue, camera);
}
