use rapier3d::prelude::RigidBodyHandle;
use uuid::Uuid;

use crate::helpers::saved_data::CollectableType;

pub struct Collectable {
    pub id: Uuid,
    pub model_id: String,
    pub collectable_type: CollectableType,
    pub rigid_body_handle: RigidBodyHandle,
}

impl Collectable {
    pub fn new(model_id: String, collectable_type: CollectableType, rigid_body_handle: RigidBodyHandle) -> Self {
        Collectable {
            id: Uuid::new_v4(),
            collectable_type,
            model_id,
            rigid_body_handle,
        }
    }
}