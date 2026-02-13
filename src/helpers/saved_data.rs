use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::{
    game_behaviors::stateful::BehaviorConfig,
    water_plane::config::WaterConfig,
    shape_primitives::polygon::SavedPolygonConfig,
    renderer_text::text_due::SavedTextRendererConfig,
    renderer_images::st_image::SavedStImageConfig,
    vector_animations::animations::{SavedStVideoConfig, AnimationData},
};

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ScatterSettings {
    pub density: f32,
    pub radius: f32,
    pub seed: u32,
}

#[derive(Hash, Eq, Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct File {
    pub id: String,
    pub fileName: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct LandscapeData {
    pub id: String,
    pub heightmap: Option<File>,
    pub rockmap: Option<File>,
    pub soil: Option<File>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug)]
pub enum ComponentKind {
    Model, // sometimes active alone
    NPC, // only active alongside a corresponding Model component
    Landscape,
    PointLight,
    WaterPlane,
    Collectable,
    PlayerCharacter,
    ProceduralTree,
    ProceduralParticle,
    ProceduralGrass,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug)]
pub enum CollectableType {
    Item,
    MeleeWeapon,
    RangedWeapon,
    Armor
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub enum FireType {
    #[default]
    Manual,
    SemiAutomatic,
    Automatic,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Copy)]
pub enum LandscapeTextureKinds {
    Primary,
    PrimaryMask,
    Rockmap,
    RockmapMask,
    Soil,
    SoilMask,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhysicsConfig {
    pub body_type: String, // "dynamic", "fixed", "kinematic"
    pub collider_shape: String, // "trimesh", "hull", "cuboid", "capsule", "ball"
    pub mass: Option<f32>,
    pub friction: Option<f32>,
    pub restitution: Option<f32>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct GenericProperties {
    pub name: String,
    pub position: [f32; 3],
    pub rotation: [f32; 3],
    pub scale: [f32; 3],
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct LandscapeProperties {
    pub size: u32,
    // regular textures
    pub primary_texture_id: Option<String>,
    pub rockmap_texture_id: Option<String>,
    pub soil_texture_id: Option<String>,
    // new pbr textures
    pub primary_pbr_texture_id: Option<String>,
    pub rockmap_pbr_texture_id: Option<String>,
    pub soil_pbr_texture_id: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ModelProperties {
    // pub id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ProceduralTreeProperties {
    pub seed: u32,
    pub trunk_height: f32,
    pub trunk_radius: f32,
    pub branch_levels: u32,
    pub foliage_radius: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ProceduralParticleProperties {
    pub emission_rate: f32,
    pub life_time: f32,
    pub radius: f32,
    pub initial_speed_min: f32,
    pub initial_speed_max: f32,
    pub size: f32,
    pub mode: f32, // 0 = continuous, 1 = burst
    pub start_color: [f32; 4],
    pub end_color: [f32; 4],
    pub gravity: [f32; 4],
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ProceduralGrassProperties {
    pub grid_size: f32,
    pub render_distance: f32,
    pub blade_density: u32,
    pub wind_strength: f32,
    pub wind_speed: f32,
    pub blade_height: f32,
    pub blade_width: f32,
    pub brownian_strength: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct CollectableProperties {
    // fallback to sphere
    pub model_id: Option<String>,
    pub collectable_type: Option<CollectableType>,
    // this allows for reuable Health Potion stat, separate from the component instance.
    // chose reusable stat over reusable collectable so other things could have stat values or changes as well 
    pub stat_id: Option<String>, 
    pub ammo: Option<u32>,
    pub max_ammo: Option<u32>,
    pub fire_type: Option<FireType>,
    pub fire_rate: Option<f32>, 
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NPCProperties {
    pub model_id: String,
    pub visual_type: Option<VisualType>,
    pub behavior: BehaviorConfig,
    pub squad_id: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum VisualType {
    #[default]
    Model,
    CustomMesh,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayerProperties {
    pub model_id: Option<String>,
    pub visual_type: Option<VisualType>,
    // default weapon is already hidden from the level / world. 
    // mounted on a Model armature (LowerArm.r to start with)
    pub default_weapon_id: Option<String>, // Component id of the Collectable (Weapon type)
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct LightProperties {
    pub intensity: f32,
    pub color: [f32; 4],
    pub max_distance: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ComponentData {
    pub id: String,
    pub kind: Option<ComponentKind>,
    pub asset_id: String, // File.id or LandscapeData.id
    pub generic_properties: GenericProperties,
    pub landscape_properties: Option<LandscapeProperties>,
    pub model_properties: Option<ModelProperties>,
    pub npc_properties: Option<NPCProperties>,
    pub light_properties: Option<LightProperties>,
    pub water_properties: Option<WaterConfig>,
    pub collectable_properties: Option<CollectableProperties>,
    pub player_properties: Option<PlayerProperties>,
    pub procedural_tree_properties: Option<ProceduralTreeProperties>,
    pub procedural_particle_properties: Option<ProceduralParticleProperties>,
    pub procedural_grass_properties: Option<ProceduralGrassProperties>,
    pub scatter: Option<ScatterSettings>,
    pub js_script_path: Option<String>,
    pub behavior_id: Option<String>,
    pub script_state: Option<HashMap<String, String>>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ProceduralSkyConfig {
    pub horizon_color: [f32; 3],
    pub zenith_color: [f32; 3],
    pub sun_direction: [f32; 3], // Normalized direction vector
    pub sun_color: [f32; 3],
    pub sun_intensity: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct LevelData {
    pub id: String,
    pub components: Option<Vec<ComponentData>>,
    #[serde(default)]
    pub procedural_sky: Option<ProceduralSkyConfig>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct ProjectData {
    pub project_id: String,
    pub project_name: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub enum AppExperience {
    #[default]
    OpenWorldStudio,
    Sophia,
    Stunts,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct ProjectRegistryEntry {
    pub project_name: String,
    pub project_id: String,
    pub app: AppExperience,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct ProjectRegistry {
    pub projects: Vec<ProjectRegistryEntry>,
}

// #[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
// pub struct ProjectsDataFile {
//     pub projects: Vec<ProjectData>,
// }

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct UIThemeProperties {
    pub primary_color: [u8; 4], // e.g. Gold
    pub secondary_color: [u8; 4], // e.g. White
    pub background_color: [u8; 4], // e.g. Grey
    pub text_color: [u8; 4],
    pub font_size_heading: f32,
    pub font_size_body: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct GameSettings {
    pub third_person: bool,
    pub show_hitscan_line: bool,
    pub ui_theme: Option<UIThemeProperties>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug)]
pub struct VideoRenderSize {
    pub width: i32,
    pub height: i32
}

impl Default for VideoRenderSize {
    fn default() -> Self {
        Self {
            width: 900,
            height: 500,
        }
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct VideoSettings {
    pub render_size: VideoRenderSize
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AttackStats {
    pub damage: f32, // TODO: should be determined be equipped weapon
    pub range: f32,
    pub cooldown: f32,
    pub wind_up_time: f32,
    pub recovery_time: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct DefenseStats {
    pub block_chance: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct CharacterStats {
    pub health: f32,
    pub stamina: f32,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct StatData {
    pub id: String,
    pub name: String,
    // stats can be be positive or negative and indicate the change either when consumed, used, or when in possession
    pub character: Option<CharacterStats>,
    pub attack: Option<AttackStats>,
    pub defense: Option<DefenseStats>,
    pub weight: Option<f32>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct PBRTextureData {
    pub id: String,
    // from PolyHaven for now
    pub diff: Option<File>, // png, tiff, and jpg seem stable
    pub disp: Option<File>, // png, tiff, and jpg seem stable
    pub nor_gl: Option<File>, // png, tiff, and jpg seem stable
    pub rough: Option<File>, // png, tiff, and jpg seem stable
    pub metallic: Option<File>, // png, tiff, and jpg seem stable
    pub ao: Option<File>, // png, tiff, and jpg seem stable
    pub arm: Option<File>, // png, tiff, and jpg seem stable // if arm is used, then ao, rough, and metallic are not needed
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ResearchResult {
    pub id: String,
    pub title: String,
    pub url: String,
    pub text: String,
    pub highlights: Vec<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct GrammarIssue {
    pub original: String,
    pub suggestion: String,
    pub explanation: String,
    pub start_index: usize,
    pub end_index: usize,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct SophiaData {
    pub research_results: Vec<ResearchResult>,
    pub subjects: Vec<String>,
    pub keywords: Vec<String>,
    pub grammar_issues: Vec<GrammarIssue>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct SavedState {
    pub id: Option<String>,
    pub project_name: String, // legacy, now stored in projects.json
    // games (open world studio)
    pub concepts: Vec<File>, // counts as Assets
    pub models: Vec<File>, // counts as Assets
    pub landscapes: Option<Vec<LandscapeData>>, // counts as Assets
    pub textures: Option<Vec<File>>, // counts as Assets
    pub pbr_textures: Option<Vec<PBRTextureData>>, // counts as Assets
    pub stats: Option<Vec<StatData>>, // Stats can be used to record a value or change tied to whatever references it
    pub levels: Option<Vec<LevelData>>, // contains Components, which are active instances of library Assets
    pub game_settings: Option<GameSettings>,
    // videos (stunts)
    pub object_motion_paths: Option<Vec<AnimationData>>,
    pub active_polygons: Option<Vec<SavedPolygonConfig>>,
    pub active_text_items: Option<Vec<SavedTextRendererConfig>>,
    pub active_image_items: Option<Vec<SavedStImageConfig>>,
    pub active_video_items: Option<Vec<SavedStVideoConfig>>,
    pub video_settings: Option<VideoSettings>,
    // writing (sophia)
    pub sophia_data: Option<SophiaData>,
    // Global
    pub global_js_scripts: Option<Vec<String>>,
}
