use serde::{Deserialize, Serialize};

use crate::animations::{
    motion_path::SkeletonMotionPath,
    skeleton::{SkeletonAssemblyConfig, SkeletonPart},
};

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
    Model,
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
pub struct ComponentData {
    pub id: String,
    pub kind: Option<ComponentKind>,
    pub asset_id: String, // File.id or LandscapeData.id
    pub generic_properties: GenericProperties,
    pub landscape_properties: Option<LandscapeProperties>,
    pub model_properties: Option<ModelProperties>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct LevelData {
    pub id: String,
    pub components: Option<Vec<ComponentData>>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Debug)]
pub struct SavedState {
    pub concepts: Vec<File>,
    pub models: Vec<File>,
    pub landscapes: Option<Vec<LandscapeData>>,
    pub textures: Option<Vec<File>>,
    pub levels: Option<Vec<LevelData>>,
    pub skeleton_parts: Vec<SkeletonPart>,
    pub skeletons: Vec<SkeletonAssemblyConfig>,
    pub motion_paths: Vec<SkeletonMotionPath>,
}
