use nalgebra::{Matrix4, Vector3};

use crate::core::Transform_2::{Transform, matrix4_to_raw_array};
use crate::helpers::saved_data::VisualType;
use wgpu::util::DeviceExt;

use super::RendererState;

impl RendererState {
    pub fn initialize_npc_visual(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, npc_id: &str, template_id: &str, visual_type: VisualType) {
        let (dummy_sampler, dummy_albedo, dummy_normal, dummy_pbr) = self.create_fallback_material_resources(device, queue);

        if let Some(npc) = self.npcs.iter_mut().find(|n| n.id == npc_id) {
            // Create unique joint buffer
            let joint_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("NPC {} Joint Buffer", npc_id)),
                contents: bytemuck::cast_slice(&[[[0.0f32; 4]; 4]; 256]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            npc.joint_matrices_buffer = Some(joint_buffer);

            // Borrow material resources from template
            let mut template_resources = None;
            if visual_type == VisualType::CustomMesh {
                // For CustomMesh, fall back to dummies for now
            } else {
                if let Some(model) = self.models.iter().chain(self.addon_models.values().flatten()).find(|m| m.id == template_id) {
                    if let Some(mesh) = model.meshes.get(0) {
                        template_resources = Some((
                            &mesh.normal_texture_view,
                            &mesh.pbr_params_texture_view,
                        ));
                    }
                }
            }
            // Create model bind group with all 6 bindings
            npc.model_bind_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &self.model_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: npc.transform.as_ref().unwrap().uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&dummy_albedo),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&dummy_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.regular_texture_render_mode_buffer,
                            offset: 0,
                            size: None,
                        }),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(template_resources.and_then(|r| r.0.as_ref()).unwrap_or(&dummy_normal)),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::TextureView(template_resources.and_then(|r| r.1.as_ref()).unwrap_or(&dummy_pbr)),
                    },
                ],
                label: Some(&format!("NPC {} Model Bind Group", npc_id)),
            }));

            // Create skin bind group
            if let Some(skinned_layout) = &self.skinned_pipeline.as_ref().map(|p| p.render_pipeline.get_bind_group_layout(2)) {
                npc.skin_bind_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                    layout: skinned_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: npc.joint_matrices_buffer.as_ref().unwrap().as_entire_binding(),
                    }],
                    label: Some(&format!("NPC {} Skin Bind Group", npc_id)),
                }));
            }
        }
    }

    pub fn initialize_player_visual(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, template_id: &str, visual_type: VisualType) {
        let (dummy_sampler, dummy_albedo, dummy_normal, dummy_pbr) = self.create_fallback_material_resources(device, queue);

        if let Some(player) = &mut self.player_character {
            // Create unique transform buffer
            let empty_buffer = Matrix4::<f32>::identity();
            let raw_matrix = matrix4_to_raw_array(&empty_buffer);
            let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("Player {} Transform Buffer", player.id)),
                contents: bytemuck::cast_slice(&raw_matrix),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

            player.transform = Some(Transform::new(
                Vector3::zeros(),
                Vector3::zeros(),
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ));

            let joint_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("Player {} Joint Buffer", player.id)),
                contents: bytemuck::cast_slice(&[[[0.0f32; 4]; 4]; 256]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            player.joint_matrices_buffer = Some(joint_buffer);

            // Borrow material resources from template
            let mut template_resources = None;
            if let Some(model) = self.models.iter().chain(self.addon_models.values().flatten()).find(|m| m.id == template_id) {
                if let Some(mesh) = model.meshes.get(0) {
                    template_resources = Some((
                        &mesh.normal_texture_view,
                        &mesh.pbr_params_texture_view,
                    ));
                }
            }



            player.model_bind_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &self.model_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: player.transform.as_ref().unwrap().uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&dummy_albedo),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&dummy_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.regular_texture_render_mode_buffer,
                            offset: 0,
                            size: None,
                        }),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(template_resources.and_then(|r| r.0.as_ref()).unwrap_or(&dummy_normal)),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::TextureView(template_resources.and_then(|r| r.1.as_ref()).unwrap_or(&dummy_pbr)),
                    },
                ],
                label: Some(&format!("Player {} Model Bind Group", player.id)),
            }));

            if let Some(skinned_layout) = &self.skinned_pipeline.as_ref().map(|p| p.render_pipeline.get_bind_group_layout(2)) {
                player.skin_bind_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                    layout: skinned_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: player.joint_matrices_buffer.as_ref().unwrap().as_entire_binding(),
                    }],
                    label: Some(&format!("Player {} Skin Bind Group", player.id)),
                }));
            }
        }
    }

    pub fn create_fallback_material_resources(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> (wgpu::Sampler, wgpu::TextureView, wgpu::TextureView, wgpu::TextureView) {
        // Albedo (White)
        let albedo = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Instanced Visual Fallback Albedo"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &albedo, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[255, 255, 255, 255],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: None },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );

        // Normal (Flat)
        let normal = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Instanced Visual Fallback Normal"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &normal, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[128, 128, 255, 255],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: None },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );

        // PBR Params
        let pbr = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Instanced Visual Fallback PBR"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &pbr, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[0, 255, 255, 255],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: None },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let view_desc = wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        };

        (sampler, albedo.create_view(&view_desc), normal.create_view(&view_desc), pbr.create_view(&view_desc))
    }
}
