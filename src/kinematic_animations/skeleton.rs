use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// NOTE: these types will be fed to AI when generating SkeletonParts

/// Categorizes joints by their purpose
// #[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
// pub enum JointType {
//     /// Standard skeletal joint
//     Standard,
//     /// Helper joint for better deformation
//     Helper,
//     /// Joint for attaching equipment/props
//     Attachment,
//     /// Joint for physics simulation
//     Physics,
//     /// Joint specifically for twist distribution
//     Twist,
//     /// Specialized joint for facial animation
//     Facial,
//     /// Control joint for IK systems
//     IKControl,
// }

/// Represents constraints on joint movement
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct JointConstraints {
    /// Minimum rotation angles in degrees for each axis
    pub rotation_min: [f32; 3], // Vec3
    /// Maximum rotation angles in degrees for each axis
    pub rotation_max: [f32; 3], // Vec3
    /// Whether to preserve volume during deformation
    pub preserve_volume: bool,
    /// Maximum allowed stretch factor for stretchy IK
    pub max_stretch: f32,
}

/// Represents a single bone/joint in the skeleton
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct Joint {
    /// Unique identifier for the joint
    pub id: String,
    /// Display name of the joint
    pub name: String,
    /// ID of the parent joint (None for root)
    pub parent_id: Option<String>,
    /// If this Joint is IK (not FK), then these setting should be added
    /// Alert AI to set ONLY IK Settings OR FK Settings
    pub ik_settings: Option<IKSettings>,
    /// If this Joint is FK (not IK), then these settings should be added
    pub fk_settings: Option<FKSettings>,
    /// Optional movement constraints
    pub constraints: Option<JointConstraints>,
}

#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct IKSettings {
    /// Ideally, the position relative to this joint's part's attachment to the root part
    pub position: [f32; 3],
}

#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct FKSettings {
    pub rotation: [f32; 4],
    pub length: f32,
}

/// Represents a chain which can be used for IK or FK depending on mode
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct KinematicChain {
    /// Unique identifier for the chain
    pub id: String,
    /// Name of the chain
    pub name: String,
    /// Joint ID of the start of the chain
    pub start_joint: String,
    /// Joint ID of the end of the chain
    pub end_joint: String,
    /// Pole vector control joint (required for now)
    pub pole_vector_joint: String,
    /// Chain-specific settings include pole vector for control point
    pub settings: KinematicSettings,
}

/// Settings for kinematic chain behavior
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct KinematicSettings {
    /// Whether the chain supports stretching
    pub allow_stretch: bool,
    /// Whether to maintain foot contact
    pub foot_contact: bool,
}

// /// Complete skeleton definition
#[derive(PartialEq, Clone, Serialize, Deserialize, Debug)]
pub struct Skeleton {
    /// Unique identifier for the skeleton
    pub id: String,
    /// load the part assembly
    pub assembly_config: SkeletonAssemblyConfig,
}

/// Configuration for a specific level of detail
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct LodConfig {
    /// LOD level (0 is highest detail)
    pub level: u32,
    /// Joints to disable at this LOD level
    pub disabled_joints: Vec<String>,
    /// Maximum influences per vertex at this LOD
    pub max_influences: u32,
}

/// Represents connection points where skeleton parts can be attached
#[derive(PartialEq, Serialize, Deserialize, Debug, Clone)]
pub struct AttachPoint {
    /// Unique identifier for this attachment point
    pub id: String,
    /// Local position relative to the parent joint
    pub local_position: [f32; 3],
    /// Local rotation as quaternion
    pub local_rotation: [f32; 4],
    /// Optional constraints for the attachment
    pub constraints: Option<JointConstraints>,
}

/// A discrete part of a skeleton that can be assembled with others
#[derive(PartialEq, Clone, Serialize, Deserialize, Debug)]
pub struct SkeletonPart {
    /// Unique identifier for this part
    pub id: String,
    /// Display name of the part
    pub name: String,
    /// The joints that make up this part
    pub joints: Vec<Joint>,
    /// Kinematic chains contained in this part
    pub k_chains: Vec<KinematicChain>,
    /// Points where this part can be attached to others
    pub attach_points: Vec<AttachPoint>,
}

/// Configuration for assembling skeleton parts
#[derive(PartialEq, Clone, Serialize, Deserialize, Debug)]
pub struct SkeletonAssemblyConfig {
    /// Unique identifier for this assembly
    pub id: String,
    /// Display name of the assembled skeleton
    pub name: String,
    /// The root part to start assembly from
    pub root_part_id: Option<String>,
    /// Connections between parts
    pub connections: Vec<PartConnection>,
    /// Global settings for the assembled skeleton
    pub settings: AssemblySettings,
}

/// Defines how two skeleton parts connect
#[derive(PartialEq, Clone, Serialize, Deserialize, Debug)]
pub struct PartConnection {
    /// ID of the parent part
    pub parent_part_id: Option<String>,
    /// ID of the child part
    pub child_part_id: Option<String>,
    /// ID of the attachment point on the parent
    pub parent_attach_point: Option<String>,
    /// ID of the attachment point on the child
    pub child_attach_point: Option<String>,
    /// Optional transform adjustments
    pub transform_offset: Option<TransformOffset>,
}

#[derive(PartialEq, Clone, Serialize, Deserialize, Debug)]
pub struct TransformOffset {
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
}

#[derive(PartialEq, Clone, Serialize, Deserialize, Debug)]
pub struct AssemblySettings {
    /// LOD settings for the assembled skeleton
    pub lod_settings: AssmeblyLodConfig,
}

#[derive(PartialEq, Clone, Serialize, Deserialize, Debug)]
pub struct AssmeblyLodConfig {
    pub use_lod_configs: bool,
}
