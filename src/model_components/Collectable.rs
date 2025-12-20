use rapier3d::prelude::RigidBodyHandle;
use uuid::Uuid;

use crate::helpers::saved_data::{CollectableType, StatData};

pub struct Collectable {
    pub id: String,
    pub model_id: String,
    pub collectable_type: CollectableType,
    pub collectable_stats: StatData,
    pub rigid_body_handle: RigidBodyHandle,
}

impl Collectable {
    pub fn new(model_id: String, collectable_type: CollectableType, collectable_stats: StatData, rigid_body_handle: RigidBodyHandle) -> Self {
        Collectable {
            id: Uuid::new_v4().to_string(),
            collectable_type,
            collectable_stats,
            model_id,
            rigid_body_handle,
        }
    }
}