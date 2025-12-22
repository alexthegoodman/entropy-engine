use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::{helpers::timelines::SavedTimelineStateConfig, vector_animations::animations::Sequence, water_plane::config::WaterConfig};

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
    pub cloudfrontUrl: String,
    pub normalFilePath: String,
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
    PlayerCharacter
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug)]
pub enum CollectableType {
    Item,
    Weapon,
    Armor
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug)]
pub enum LandscapeTextureKinds {
    Primary,
    PrimaryMask,
    Rockmap,
    RockmapMask,
    Soil,
    SoilMask,
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
pub struct CollectableProperties {
    // fallback to sphere
    pub model_id: Option<String>,
    pub collectable_type: Option<CollectableType>,
    // this allows for reuable Health Potion stat, separate from the component instance.
    // chose reusable stat over reusable collectable so other things could have stat values or changes as well 
    pub stat_id: Option<String>, 
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct NPCProperties {
    pub model_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct PlayerProperties {
    pub model_id: Option<String>,
    // default weapon is already hidden from the level / world. 
    // TODO: ready to be mounted on a Model armature (LowerArm.r to start with) 
    // (will need to set as equipped weapon in inventory as well)
    pub default_weapon_id: Option<String>, // Component id of the Collectable (Weapon type)
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct LightProperties {
    pub intensity: f32,
    pub color: [f32; 4],
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
    #[serde(default)]
    pub scatter: Option<ScatterSettings>,
    pub rhai_script_path: Option<String>,
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

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct ProjectsDataFile {
    pub projects: Vec<ProjectData>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug, Default)]
pub struct GameSettings {
    pub third_person: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct AttackStats {
    pub damage: f32,
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
    pub diff: Option<File>, // will be an .jpg for now
    pub disp: Option<File>, // will be an .png for now
    pub nor_gl: Option<File>, // will be an .exr for now
    pub rough: Option<File>, // will be an .exr for now
    pub metallic: Option<File>, // will be an .exr for now
    pub ao: Option<File>, // will be an .exr for now
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug, Default)]
pub struct SavedState {
    pub id: Option<String>,
    pub project_name: String,
    // games
    pub concepts: Vec<File>, // counts as Assets
    pub models: Vec<File>, // counts as Assets
    pub landscapes: Option<Vec<LandscapeData>>, // counts as Assets
    pub textures: Option<Vec<File>>, // counts as Assets
    pub pbr_textures: Option<Vec<PBRTextureData>>, // counts as Assets
    pub stats: Option<Vec<StatData>>, // Stats can be used to record a value or change tied to whatever references it
    pub levels: Option<Vec<LevelData>>, // contains Components, which are active instances of library Assets
    // videos
    pub sequences: Option<Vec<Sequence>>,
    pub timeline_state: Option<SavedTimelineStateConfig>,
    pub global_rhai_scripts: Option<Vec<String>>,
}
