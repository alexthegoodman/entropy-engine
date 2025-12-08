use serde::{Deserialize, Serialize};

use crate::{helpers::timelines::SavedTimelineStateConfig, kinematic_animations::{
    motion_path::SkeletonMotionPath,
    skeleton::{SkeletonAssemblyConfig, SkeletonPart},
}, vector_animations::animations::Sequence};

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
    pub primary_texture_id: Option<String>,
    pub rockmap_texture_id: Option<String>,
    pub soil_texture_id: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct ModelProperties {
    // pub id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct NPCProperties {
    pub model_id: String,
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
    #[serde(default)]
    pub scatter: Option<ScatterSettings>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct LevelData {
    pub id: String,
    pub components: Option<Vec<ComponentData>>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct ProjectData {
    pub project_id: String,
    pub project_name: String,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct ProjectsDataFile {
    pub projects: Vec<ProjectData>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug)]
pub struct SavedState {
    // games
    pub concepts: Vec<File>, // counts as Assets
    pub models: Vec<File>, // counts as Assets
    pub landscapes: Option<Vec<LandscapeData>>, // counts as Assets
    pub textures: Option<Vec<File>>, // counts as Assets
    pub levels: Option<Vec<LevelData>>, // contains Components, which are active instances of library Assets
    pub skeleton_parts: Vec<SkeletonPart>,
    pub skeletons: Vec<SkeletonAssemblyConfig>,
    pub motion_paths: Vec<SkeletonMotionPath>,
    // videos
    pub id: Option<String>,
    pub sequences: Option<Vec<Sequence>>,
    pub timeline_state: Option<SavedTimelineStateConfig>,
}
