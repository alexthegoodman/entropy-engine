use nalgebra::{Isometry3, Translation3, UnitQuaternion, Vector3};

#[cfg(target_arch = "wasm32")]
use crate::helpers::wasm_loaders::read_landscape_heightmap_as_texture_wasm;
use crate::{
    core::{Texture::{Texture, pack_pbr_textures}, editor::Editor}, 
    handlers::{fetch_mask_data, handle_add_collectable, handle_add_grass, handle_add_house, handle_add_landscape, handle_add_model, handle_add_npc, handle_add_player, handle_add_trees, handle_add_water_plane}, 
    heightfield_landscapes::Landscape::{PBRMaterialType, PBRTextureKind}, 
    helpers::{landscapes::{read_landscape_heightmap_as_texture, read_texture_bytes}, 
    saved_data::{ComponentKind, LandscapeTextureKinds, SavedState}, utilities},
    procedural_models::House::HouseConfig
};

pub async fn load_project(editor: &mut Editor, project_id: &str) {
    // let editor = self.export_editor.as_mut().unwrap();
    match utilities::load_project_state(project_id).await {
        Ok(loaded_state) => {
            place_project(editor, project_id, loaded_state).await;
            }
        Err(e) => {
            println!("Failed to load project: {}", e);
        }
    }
}

pub async fn place_project(editor: &mut Editor, project_id: &str, loaded_state: SavedState) {
editor.saved_state = Some(loaded_state);
            
            let renderer_state = editor.renderer_state.as_mut().unwrap();
            let camera = editor.camera.as_mut().unwrap();
            let gpu_resources = editor.gpu_resources.as_ref().unwrap();

            // now load landscapes
            if let Some(saved_state) = &editor.saved_state {
                if let Some(landscapes) = &saved_state.landscapes {
                    if let Some(levels) = &saved_state.levels {
                        let level = &levels[0]; // assume one level for now
                        for landscape_data in landscapes {
                            if let Some(components) = &level.components {
                                for component in components {
                                    if let Some(ComponentKind::Landscape) = component.kind {
                                        if component.asset_id == landscape_data.id {
                                            if let Some(heightmap) = &landscape_data.heightmap {
                                                
                                                handle_add_landscape(
                                                    renderer_state,
                                                    &gpu_resources.device,
                                                    &gpu_resources.queue,
                                                    project_id.to_string(),
                                                    landscape_data.id.clone(),
                                                    component.id.clone(),
                                                    heightmap.fileName.clone(),
                                                    component.generic_properties.position,
                                                    camera,
                                                ).await;

                                                // Existing texture loading for regular textures (optional, can be removed if fully PBR)
                                                if let Some(textures) = &saved_state.textures {
                                                    let landscape_properties = component.landscape_properties.as_ref().expect("Couldn't get landscape properties");

                                                    // if let Some(texture_id) = &landscape_properties.rockmap_texture_id {
                                                    //     let rockmap_texture = textures.iter().find(|t| {
                                                    //         if &t.id == texture_id {
                                                    //             true
                                                    //         } else {
                                                    //             false
                                                    //         }
                                                    //     });
                                                        
                                                    //     if let Some(rock_texture) = rockmap_texture {
                                                    //         if let Some(rock_mask) = &landscape_data.rockmap {
                                                    //             handle_add_landscape_texture(renderer_state, &gpu_resources.device,
                                                    //             &gpu_resources.queue, project_id.to_string(), component.id.clone(), 
                                                    //             landscape_data.id.clone(), rock_texture.fileName.clone(), LandscapeTextureKinds::Rockmap, rock_mask.fileName.clone());
                                                    //         }
                                                    //     }
                                                    // }
                                                    // if let Some(texture_id) = &landscape_properties.soil_texture_id {
                                                    //     let soil_texture = textures.iter().find(|t| {
                                                    //         if &t.id == texture_id {
                                                    //             true
                                                    //         } else {
                                                    //             false
                                                    //         }
                                                    //     });
                                                        
                                                    //     if let Some(soil_texture) = soil_texture {
                                                    //         if let Some(soil_mask) = &landscape_data.soil {
                                                    //             handle_add_landscape_texture(renderer_state, &gpu_resources.device,
                                                    //             &gpu_resources.queue, project_id.to_string(), component.id.clone(), 
                                                    //             landscape_data.id.clone(), soil_texture.fileName.clone(), LandscapeTextureKinds::Soil, soil_mask.fileName.clone());
                                                    //         }
                                                    //     }
                                                    // }
                                                }

                                                // NEW: Load PBR textures
                                                if let Some(pbr_textures) = &saved_state.pbr_textures {
                                                    if let Some(mut landscape_obj) = renderer_state.landscapes.iter_mut().find(|l| l.id == component.id) {
                                                        let landscape_properties = component.landscape_properties.as_ref().expect("Couldn't get landscape properties");

                                                        let model_bind_group_layout = editor.model_bind_group_layout.as_ref().unwrap();
                                                        let texture_render_mode_buffer = renderer_state.texture_render_mode_buffer.clone();
                                                        let color_render_mode_buffer = renderer_state.color_render_mode_buffer.clone();

                                                        if let Some(rock_mask) = &landscape_data.rockmap {
                                                            let mask = fetch_mask_data(
                                                                project_id.to_string().clone(),
                                                                component.asset_id.clone(),
                                                                rock_mask.fileName.clone(),
                                                                LandscapeTextureKinds::Rockmap,
                                                            ).await;
                                                            landscape_obj.update_texture(
                                                                &gpu_resources.device, 
                                                                &gpu_resources.queue, 
                                                                model_bind_group_layout, 
                                                                &texture_render_mode_buffer, 
                                                                &color_render_mode_buffer, 
                                                                LandscapeTextureKinds::RockmapMask, 
                                                                &mask
                                                            );
                                                        }
                                                        if let Some(soil_mask) = &landscape_data.soil {
                                                            let mask = fetch_mask_data(
                                                                project_id.to_string().clone(),
                                                                component.asset_id.clone(),
                                                                soil_mask.fileName.clone(),
                                                                LandscapeTextureKinds::Soil,
                                                            ).await;
                                                            landscape_obj.update_texture(
                                                                &gpu_resources.device, 
                                                                &gpu_resources.queue, 
                                                                model_bind_group_layout, 
                                                                &texture_render_mode_buffer, 
                                                                &color_render_mode_buffer, 
                                                                LandscapeTextureKinds::SoilMask, 
                                                                &mask
                                                            );
                                                        }

                                                        // Rockmap PBR Texture (similar logic as primary)
                                                        if let Some(pbr_texture_id) = &landscape_properties.rockmap_pbr_texture_id {
                                                            if let Some(pbr_data) = pbr_textures.iter().find(|p| &p.id == pbr_texture_id) {
                                                                // Load diffuse (albedo)
                                                                if let Some(diff_file) = &pbr_data.diff {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), diff_file.fileName.clone()).await {
                                                                        if let texture = Texture::new(data.0, data.1, data.2) {
                                                                            landscape_obj.update_texture(&gpu_resources.device, &gpu_resources.queue, model_bind_group_layout, &texture_render_mode_buffer, &color_render_mode_buffer, LandscapeTextureKinds::Rockmap, &texture);
                                                                        } else {
                                                                            println!("Can't create PBR diff Texture");
                                                                        }   
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }
                                                                // Load normal
                                                                if let Some(nor_gl_file) = &pbr_data.nor_gl {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), nor_gl_file.fileName.clone()).await {
                                                                        if let texture = Texture::new(data.0, data.1, data.2) {
                                                                            landscape_obj.update_pbr_texture(&gpu_resources.device, &gpu_resources.queue, model_bind_group_layout, &texture_render_mode_buffer, &color_render_mode_buffer, PBRTextureKind::Normal, PBRMaterialType::Rockmap, &texture);
                                                                        } else {
                                                                            println!("Can't create PBR Texture");
                                                                        }
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }

                                                                let mut rough_tex = None;
                                                                let mut metallic_tex = None;
                                                                let mut ao_tex = None;                                                                    

                                                                // Load roughness/metallic/AO
                                                                // let mut pbr_params_data = vec![0u8; 4];
                                                                if let Some(rough_file) = &pbr_data.rough {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), rough_file.fileName.clone()).await {
                                                                        rough_tex = Some(Texture::new(data.0, data.1, data.2));
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }
                                                                if let Some(metallic_file) = &pbr_data.metallic {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), metallic_file.fileName.clone()).await {
                                                                        metallic_tex = Some(Texture::new(data.0, data.1, data.2));
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }
                                                                if let Some(ao_file) = &pbr_data.ao {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), ao_file.fileName.clone()).await {
                                                                        ao_tex = Some(Texture::new(data.0, data.1, data.2));
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }

                                                                let pbr_params_data = pack_pbr_textures(rough_tex, metallic_tex, ao_tex);

                                                                // let pbr_params_texture = Texture::from_bytes_1x1(&gpu_resources.device, &gpu_resources.queue, &pbr_params_data, "packed_pbr_params", false);
                                                                if let Ok(texture) = pbr_params_data {
                                                                    landscape_obj.update_pbr_texture(&gpu_resources.device, &gpu_resources.queue, model_bind_group_layout, &texture_render_mode_buffer, &color_render_mode_buffer, PBRTextureKind::MetallicRoughnessAO, PBRMaterialType::Rockmap, &texture);
                                                                } else {
                                                                    println!("Can't create PBR Texture");
                                                                }
                                                            }
                                                        }

                                                        // Soil PBR Texture (similar logic as primary)
                                                        if let Some(pbr_texture_id) = &landscape_properties.soil_pbr_texture_id {
                                                            if let Some(pbr_data) = pbr_textures.iter().find(|p| &p.id == pbr_texture_id) {
                                                                // Load diffuse (albedo)
                                                                if let Some(diff_file) = &pbr_data.diff {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), diff_file.fileName.clone()).await {
                                                                        if let texture = Texture::new(data.0, data.1, data.2) {
                                                                            landscape_obj.update_texture(&gpu_resources.device, &gpu_resources.queue, model_bind_group_layout, &texture_render_mode_buffer, &color_render_mode_buffer, LandscapeTextureKinds::Soil, &texture);
                                                                        } else {
                                                                            println!("Can't create PBR diff Texture");
                                                                        }   
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }
                                                                // Load normal
                                                                if let Some(nor_gl_file) = &pbr_data.nor_gl {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), nor_gl_file.fileName.clone()).await {
                                                                        if let texture = Texture::new(data.0, data.1, data.2) {
                                                                            landscape_obj.update_pbr_texture(&gpu_resources.device, &gpu_resources.queue, model_bind_group_layout, &texture_render_mode_buffer, &color_render_mode_buffer, PBRTextureKind::Normal, PBRMaterialType::Soil, &texture);
                                                                        } else {
                                                                            println!("Can't create PBR Texture");
                                                                        }   
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }
                                                                // Load roughness/metallic/AO
                                                                // let mut pbr_params_data = vec![0u8; 4];
                                                                // if let Some(rough_file) = &pbr_data.rough {
                                                                //     if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), rough_file.fileName.clone()) {
                                                                //         if let texture = Texture::new(data.0, data.1, data.2) {
                                                                //             if !texture.data.is_empty() {
                                                                //                 pbr_params_data[0] = texture.data[0];
                                                                //             }
                                                                //         }
                                                                //     } else {
                                                                //         println!("Failed to load texture!");
                                                                //     }
                                                                // }
                                                                // if let Some(metallic_file) = &pbr_data.metallic {
                                                                //     if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), metallic_file.fileName.clone()) {
                                                                //         if let texture = Texture::new(data.0, data.1, data.2) {
                                                                //             if !texture.data.is_empty() {
                                                                //                 pbr_params_data[1] = texture.data[0];
                                                                //             }
                                                                //         }
                                                                //     } else {
                                                                //         println!("Failed to load texture!");
                                                                //     }
                                                                // }
                                                                // if let Some(ao_file) = &pbr_data.ao {
                                                                //     if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), ao_file.fileName.clone()) {
                                                                //         if let texture = Texture::new(data.0, data.1, data.2) {
                                                                //             if !texture.data.is_empty() {
                                                                //                 pbr_params_data[2] = texture.data[0];
                                                                //             }
                                                                //         }
                                                                //     } else {
                                                                //         println!("Failed to load texture!");
                                                                //     }
                                                                // }
                                                                // let pbr_params_texture = Texture::from_bytes_1x1(&gpu_resources.device, &gpu_resources.queue, &pbr_params_data, "packed_pbr_params", false);
                                                                
                                                                let mut rough_tex = None;
                                                                let mut metallic_tex = None;
                                                                let mut ao_tex = None;                                                                    

                                                                // Load roughness/metallic/AO
                                                                // let mut pbr_params_data = vec![0u8; 4];
                                                                if let Some(rough_file) = &pbr_data.rough {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), rough_file.fileName.clone()).await {
                                                                        rough_tex = Some(Texture::new(data.0, data.1, data.2));
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }
                                                                if let Some(metallic_file) = &pbr_data.metallic {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), metallic_file.fileName.clone()).await {
                                                                        metallic_tex = Some(Texture::new(data.0, data.1, data.2));
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }
                                                                if let Some(ao_file) = &pbr_data.ao {
                                                                    if let Ok(data) = read_texture_bytes(project_id.to_string(), pbr_texture_id.clone(), ao_file.fileName.clone()).await {
                                                                        ao_tex = Some(Texture::new(data.0, data.1, data.2));
                                                                    } else {
                                                                        println!("Failed to load texture!");
                                                                    }
                                                                }

                                                                let pbr_params_data = pack_pbr_textures(rough_tex, metallic_tex, ao_tex);

                                                                if let Ok(texture) = pbr_params_data {
                                                                    landscape_obj.update_pbr_texture(&gpu_resources.device, &gpu_resources.queue, model_bind_group_layout, &texture_render_mode_buffer, &color_render_mode_buffer, PBRTextureKind::MetallicRoughnessAO, PBRMaterialType::Soil, &texture);
                                                                } else {
                                                                    println!("Can't create PBR Texture");
                                                                }
                                                            }
                                                        }
                                                    }
                                                }

                                                #[cfg(target_os = "windows")]
                                                let heightmap_texture = read_landscape_heightmap_as_texture(project_id.to_string(), landscape_data.id.clone(), heightmap.fileName.clone());

                                                #[cfg(target_arch = "wasm32")]
                                                let heightmap_texture = read_landscape_heightmap_as_texture_wasm(project_id.to_string(), landscape_data.id.clone(), heightmap.fileName.clone()).await;

                                                if let Some(texture) = heightmap_texture.ok() {
                                                    // TODO: only load in when in saved state / data, and with the desireed configuration (ex. grass color)
                                                    let camera_binding = editor.camera_binding.as_ref().expect("Couldn't get camera binding");

                                                    handle_add_grass(
                                                        renderer_state,
                                                        &gpu_resources.device,
                                                        &gpu_resources.queue,
                                                        &camera_binding.bind_group_layout,
                                                        &editor.model_bind_group_layout.as_ref().expect("Couldn't get layout"),
                                                        &component.id.clone(),
                                                        texture
                                                    );

                                                    handle_add_water_plane(
                                                        renderer_state, 
                                                        &gpu_resources.device, 
                                                        &camera_binding.bind_group_layout, 
                                                        wgpu::TextureFormat::Rgba16Float,
                                                        component.id.clone()
                                                    );

                                                    handle_add_trees(renderer_state, &gpu_resources.device,
                                                        &gpu_resources.queue, &camera_binding.bind_group_layout);
                                                }
                                            }
                                        }
                                    }
                                    if let Some(ComponentKind::Model) = component.kind {
                                        let asset = saved_state.models.iter().find(|m| m.id == component.asset_id);
                                        let model_position = Translation3::new(component.generic_properties.position[0], component.generic_properties.position[1], component.generic_properties.position[2]);
                                        let model_rotation = UnitQuaternion::from_euler_angles(component.generic_properties.rotation[0].to_radians(), component.generic_properties.rotation[1].to_radians(), component.generic_properties.rotation[2].to_radians());
                                        let model_iso = Isometry3::from_parts(model_position, model_rotation);
                                        let model_scale = Vector3::new(component.generic_properties.scale[0], component.generic_properties.scale[1], component.generic_properties.scale[2]);

                                        if let Some(asset_item) = asset {
                                            handle_add_model(
                                                renderer_state,  
                                                &gpu_resources.device,
                                                &gpu_resources.queue, 
                                                project_id.to_string(), 
                                                asset_item.id.clone(), 
                                                component.id.clone(), 
                                                asset_item.fileName.clone(), 
                                                model_iso, 
                                                model_scale,
                                                camera
                                            ).await;
                                        }
                                    }
                                    if let Some(ComponentKind::PlayerCharacter) = component.kind {
                                        let asset = saved_state.models.iter().find(|m| m.id == component.asset_id);
                                        let model_position = Translation3::new(component.generic_properties.position[0], component.generic_properties.position[1], component.generic_properties.position[2]);
                                        let model_rotation = UnitQuaternion::from_euler_angles(component.generic_properties.rotation[0].to_radians(), component.generic_properties.rotation[1].to_radians(), component.generic_properties.rotation[2].to_radians());
                                        let model_iso = Isometry3::from_parts(model_position, model_rotation);
                                        let model_scale = Vector3::new(component.generic_properties.scale[0], component.generic_properties.scale[1], component.generic_properties.scale[2]);

                                        if let Some(asset_item) = asset {
                                            handle_add_player(
                                                renderer_state,  
                                                &gpu_resources.device,
                                                &gpu_resources.queue, 
                                                project_id.to_string(), 
                                                asset_item.id.clone(), 
                                                component.id.clone(), 
                                                asset_item.fileName.clone(), 
                                                model_iso, 
                                                model_scale,
                                                camera
                                            ).await;
                                        }
                                    }
                                    if let Some(ComponentKind::NPC) = component.kind {
                                        let asset = saved_state.models.iter().find(|m| m.id == component.asset_id);
                                        let model_position = Translation3::new(component.generic_properties.position[0], component.generic_properties.position[1], component.generic_properties.position[2]);
                                        let model_rotation = UnitQuaternion::from_euler_angles(component.generic_properties.rotation[0].to_radians(), component.generic_properties.rotation[1].to_radians(), component.generic_properties.rotation[2].to_radians());
                                        let model_iso = Isometry3::from_parts(model_position, model_rotation);
                                        let model_scale = Vector3::new(component.generic_properties.scale[0], component.generic_properties.scale[1], component.generic_properties.scale[2]);

                                        if let Some(asset_item) = asset {
                                            handle_add_npc(
                                                renderer_state,  
                                                &gpu_resources.device,
                                                &gpu_resources.queue, 
                                                project_id.to_string(), 
                                                asset_item.id.clone(), 
                                                component.id.clone(), 
                                                asset_item.fileName.clone(), 
                                                model_iso, 
                                                model_scale,
                                                camera
                                            ).await;
                                        }
                                    }
                                    if let Some(ComponentKind::Collectable) = component.kind {
                                        let asset = saved_state.models.iter().find(|m| m.id == component.asset_id);
                                        let model_position = Translation3::new(component.generic_properties.position[0], component.generic_properties.position[1], component.generic_properties.position[2]);
                                        let model_rotation = UnitQuaternion::from_euler_angles(component.generic_properties.rotation[0].to_radians(), component.generic_properties.rotation[1].to_radians(), component.generic_properties.rotation[2].to_radians());
                                        let model_iso = Isometry3::from_parts(model_position, model_rotation);
                                        let model_scale = Vector3::new(component.generic_properties.scale[0], component.generic_properties.scale[1], component.generic_properties.scale[2]);

                                        let collectable_properties = component.collectable_properties.as_ref().expect("Couldn't find collectable properties");
                                        let stat_id = collectable_properties.stat_id.as_ref().expect("Couldn't get collectable type");
                                        let stats = saved_state.stats.as_ref().expect("Couldn't find any stats");
                                        let related_stat = stats.iter().find(|s| s.id == stat_id.clone());
                                        let related_stat = related_stat.as_ref().expect("Couldn't get related stat");

                                        let character = components.iter().find(|c| c.kind == Some(ComponentKind::PlayerCharacter));

                                        let mut hide_in_world = false;

                                        if let Some(character) = character {
                                            if let Some(data) = &character.player_properties {
                                            if let Some(default_weapon_id) = data.default_weapon_id.clone() {
                                                if default_weapon_id == component.id {
                                                    hide_in_world = true;
                                                }
                                            }
                                            }
                                        }

                                        println!("Adding collectale. Hidden in world: {:?}", hide_in_world);

                                        if let Some(asset_item) = asset {
                                            handle_add_collectable(
                                                renderer_state,  
                                                &gpu_resources.device,
                                                &gpu_resources.queue, 
                                                project_id.to_string(), 
                                                asset_item.id.clone(), 
                                                component.id.clone(), 
                                                asset_item.fileName.clone(), 
                                                model_iso, 
                                                model_scale,
                                                camera,
                                                collectable_properties,
                                                related_stat,
                                                hide_in_world
                                            ).await;
                                        }
                                    }

                                    if let Some(crate::helpers::saved_data::ComponentKind::PointLight) = component.kind {
                                        if let Some(light_props) = component.light_properties.as_ref() {
                                            renderer_state.point_lights.push(crate::core::editor::PointLight {
                                                position: component.generic_properties.position,
                                                _padding1: 0,
                                                color: [light_props.color[0], light_props.color[1], light_props.color[2]],
                                                _padding2: 0,
                                                intensity: light_props.intensity,
                                                max_distance: 800.0, // Default max distance for now
                                                _padding3: [0; 2],
                                            });
                                            // if current_point_lights.len() >= crate::core::editor::MAX_POINT_LIGHTS {
                                            //     break; // Stop if we reach max number of lights
                                            // }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            // just for testing:
            // let house_config = HouseConfig::default();
            // let house_position = Translation3::new(10.0, -20.0, 10.0);
            // let house_rotation = UnitQuaternion::from_euler_angles(0.0, 0.0, 0.0);
            // let house_iso = Isometry3::from_parts(house_position, house_rotation);
            // handle_add_house(
            //     renderer_state,
            //     &gpu_resources.device,
            //     &gpu_resources.queue,
            //     "test_house".to_string(),
            //     &house_config,
            //     house_iso,
            // ).await;
}
