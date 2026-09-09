use nalgebra::{Isometry3, Vector3};
use uuid::Uuid;

use crate::art_assets::ScatteredModel::ScatteredModel;
use crate::deno::addon_ops::VisualConfig;
use crate::helpers::saved_data::{PhysicsConfig, ScatterSettings, VisualType};
use crate::art_assets::Model::Model;
use crate::procedural_models::House::{House, HouseConfig};
use crate::heightfield_landscapes::Landscape::Landscape;
use crate::helpers::landscapes::LandscapePixelData;
use std::collections::HashMap;
use wgpu::util::DeviceExt;

use super::RendererState;
use super::super::SimpleCamera::SimpleCamera;

impl RendererState {
    pub fn add_model(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_component_id: &String,
        bytes: &Vec<u8>,
        isometry: Isometry3<f32>,
        scale: Vector3<f32>,
        camera: &SimpleCamera,
        hide_in_world: bool,
        script_state: Option<HashMap<String, String>>,
        physics_config: Option<PhysicsConfig>,
        behavior_id: Option<String>
    ) {
        let mut model = Model::from_glb(
            model_component_id,
            bytes,
            device,
            queue,
            &self.model_bind_group_layout,
            &self.group_bind_group_layout,
            &self.regular_texture_render_mode_buffer,
            &self.color_render_mode_buffer,
            isometry,
            scale,
            camera,
            physics_config
        );

        model.hide_from_world = hide_in_world;

        model.script_state = script_state;
        model.behavior_id = behavior_id;

        // Check if the model has skins and create the necessary GPU resources
        if !model.skins.is_empty() {
            const MAX_JOINTS: usize = 256;

            if let Some(skinned_pipeline) = &self.skinned_pipeline {
                let joint_matrices_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Joint Matrices Buffer"),
                    contents: bytemuck::cast_slice(&[[0.0f32; 16]; MAX_JOINTS]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

                let skin_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Skin Bind Group"),
                    layout: &skinned_pipeline.skin_bind_group_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: joint_matrices_buffer.as_entire_binding(),
                    }],
                });

                model.joint_matrices_buffer = Some(joint_matrices_buffer);
                model.skin_bind_group = Some(skin_bind_group);
            } else {
                eprintln!("Warning: Model has skins but skinned_pipeline is not initialized in RendererState.");
            }
        }
        self.models.push(model);
    }

    pub fn add_addon_model(
        &mut self,
        addon_name: &String,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_component_id: &String,
        bytes: &Vec<u8>,
        isometry: Isometry3<f32>,
        scale: Vector3<f32>,
        camera: &SimpleCamera,
        hide_in_world: bool,
        script_state: Option<HashMap<String, String>>,
        physics_config: Option<PhysicsConfig>,
        behavior_id: Option<String>
    ) {
        let mut model = Model::from_glb(
            model_component_id,
            bytes,
            device,
            queue,
            &self.model_bind_group_layout,
            &self.group_bind_group_layout,
            &self.regular_texture_render_mode_buffer,
            &self.color_render_mode_buffer,
            isometry,
            scale,
            camera,
            physics_config
        );

        model.hide_from_world = hide_in_world;
        model.script_state = script_state;
        model.behavior_id = behavior_id;

        if !model.skins.is_empty() {
            const MAX_JOINTS: usize = 256;
            if let Some(skinned_pipeline) = &self.skinned_pipeline {
                let joint_matrices_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Joint Matrices Buffer"),
                    contents: bytemuck::cast_slice(&[[0.0f32; 16]; MAX_JOINTS]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

                let skin_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Skin Bind Group"),
                    layout: &skinned_pipeline.skin_bind_group_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: joint_matrices_buffer.as_entire_binding(),
                    }],
                });

                model.joint_matrices_buffer = Some(joint_matrices_buffer);
                model.skin_bind_group = Some(skin_bind_group);
            }
        }

        let addon_list = self.addon_models.entry(addon_name.clone()).or_insert_with(Vec::new);

        // If it already exists, replace it, otherwise push
        if let Some(pos) = addon_list.iter().position(|m| m.id == *model_component_id) {
            addon_list[pos] = model;
        } else {
            addon_list.push(model);
        }
    }

    pub fn add_player_character(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_component_id: String,
        isometry: Isometry3<f32>,
        scale: Vector3<f32>,
        camera: &SimpleCamera,
        player_properties: crate::helpers::saved_data::PlayerProperties
    ) {
        use crate::model_components::PlayerCharacter::PlayerCharacter;
        use crate::helpers::saved_data::ComponentKind;

        let visual_type = player_properties.visual_type.unwrap_or_default();

        // PlayerCharacter::new will handle adding to rigid_body_set and collider_set
        let mut player_character = PlayerCharacter::new(
            model_component_id.clone(),
            &mut self.rigid_body_set,
            &mut self.collider_set,
            device,
            queue,
            &self.model_bind_group_layout,
            &self.group_bind_group_layout,
            &self.regular_texture_render_mode_buffer,
            camera,
            isometry,
            scale,
            None, // default_weapon - we'll handle this via player_properties later if needed
            visual_type.clone()
        );

        player_character.model_id = Some(model_component_id.clone());
        self.player_character = Some(player_character);
        self.add_collider(model_component_id, ComponentKind::PlayerCharacter, Some(visual_type.clone()));
    }

    pub fn add_npc(
        &mut self,
        model_component_id: String,
        npc_properties: crate::helpers::saved_data::NPCProperties,
        behavior_id: Option<String>,
        visual_config: Option<VisualConfig>,
    ) {

        use crate::model_components::NPC::NPC;
        use crate::helpers::saved_data::ComponentKind;

        let visual_type = npc_properties.visual_type.unwrap_or_default();

        // Retrieve the rigid_body_handle after the collider has been added
        let npc_rigid_body_handle = if visual_type == crate::helpers::saved_data::VisualType::Model {
            self.add_collider(model_component_id.clone(), ComponentKind::NPC, Some(visual_type.clone()));

            self
                .models
                .iter()
                .chain(self.addon_models.values().flatten())
                .find(|m| m.id == model_component_id)
                .and_then(|m| m.meshes.get(0))
                .and_then(|mesh| Some(mesh.rigid_body_handle))
                .expect("Couldn't retrieve rigid body handle for NPC Model after adding collider")
        } else {
            None
        };

        let gpu_resources = self.gpu_resources.as_ref().expect("Couldn't get resources");

        let squad_id = npc_properties.squad_id.clone();

        let mesh_id = if let Some(config) = visual_config.clone() {
            config.template_id
        } else {
            model_component_id.clone()
        };

        let mut npc = NPC::new(
            &gpu_resources.device,
            &gpu_resources.queue,
            model_component_id.clone(),
            mesh_id.clone(),
            visual_type.clone(),
            npc_rigid_body_handle,
            npc_properties.behavior.clone(),
            squad_id,
            visual_config
        );
        npc.behavior_id = behavior_id;
        self.npcs.push(npc);

        if visual_type == VisualType::CustomMesh {
            // add collider for custom mesh afterward
            self.add_collider(model_component_id.clone(), ComponentKind::NPC, Some(visual_type.clone()));
        }

    }

    pub fn add_house(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        house_component_id: &String,
        config: &HouseConfig,
        isometry: Isometry3<f32>,
    ) {
        let mut house = House::new(
            house_component_id,
            device,
            queue,
            &self.model_bind_group_layout,
            config,
            isometry,
        );

        for mesh in &mut house.meshes {
            let rigid_body_handle = self.rigid_body_set.insert(mesh.rigid_body.clone());
            mesh.rigid_body_handle = Some(rigid_body_handle);

            let collider_handle = self.collider_set.insert_with_parent(
                mesh.collider.clone(),
                rigid_body_handle,
                &mut self.rigid_body_set,
            );
            mesh.collider_handle = Some(collider_handle);
        }

        self.procedural_houses.push(house);
    }

    pub fn add_scattered_model(
        &mut self,
        device: &wgpu::Device,
        model: Model,
        scatter_options: ScatterSettings
    ) {
        if let Some(landscape) = self.landscapes.get_mut(0) {
            if let Some(pipeline) = &self.scattered_model_pipeline {
                let scattered = ScatteredModel::new(
                    device,
                    model,
                    scatter_options,
                    landscape,
                    &pipeline.uniform_bind_group_layout
                );
                self.scattered_models.push(scattered);
            } else {
                println!("Scattered model pipeline not initialized");
            }
        } else {
            println!("Cannot add scattered model: No landscape found!");
        }
    }

    pub fn add_landscape(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        landscapeComponentId: &String,
        data: &LandscapePixelData,
        position: [f32; 3],
        camera: &SimpleCamera
    ) {
        let landscape = Landscape::new(
            landscapeComponentId,
            data,
            device,
            queue,
            &self.model_bind_group_layout,
            &self.group_bind_group_layout,
            &self.texture_render_mode_buffer,
            &self.color_render_mode_buffer,
            position,
            camera,
            None
        );

        self.landscapes.push(landscape);
    }

    pub fn add_terrain_manager(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        projectId: String,
        landscapeAssetId: String,
        landscapeComponentId: String,
        landscapeFilename: String,
        position: [f32; 3],
        camera: &mut SimpleCamera
    ) {
        // let terrain_manager = TerrainManager::new(
        //     projectId,
        //     landscapeComponentId,
        //     landscapeAssetId,
        //     landscapeFilename,
        //     device,
        //     queue,
        //     &self.model_bind_group_layout,
        //     &self.group_bind_group_layout,
        //     &self.texture_render_mode_buffer,
        //     position,
        //     camera
        // );

        // self.terrain_managers.push(terrain_manager);
    }
}
