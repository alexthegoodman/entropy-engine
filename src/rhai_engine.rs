use rhai::{Engine, Scope, AST, Dynamic, Array, CustomType, TypeBuilder, Func, NativeCallContext};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use nalgebra::Vector3;

use crate::core::RendererState::RendererState;
use crate::art_assets::Model::Model;
use crate::helpers::saved_data::ComponentData;
use crate::scripting_commands::Command;

#[derive(Clone)]
pub struct ModelWrapper {
    pub id: String,
    pub position: Vector3<f32>,
}

pub struct RhaiEngine {
    engine: Engine,
    ast_cache: HashMap<String, AST>,
}

impl RhaiEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();
        
        engine.on_print(|text| {
            println!("[RHAI] {}", text);
        });

        // Register the Command enum
        engine.build_type::<Command>();
        
        // Register a function to create Command::SetPosition
        engine.register_fn("SetPosition", |component_id: String, position: Array| {
            Command::SetPosition { component_id, position: [
                    position[0].as_float().unwrap_or(0.0) as f32, 
                    position[1].as_float().unwrap_or(0.0) as f32, 
                    position[2].as_float().unwrap_or(0.0) as f32
                ] 
            }
        });

        // Register the ModelWrapper
        engine.register_type_with_name::<ModelWrapper>("ComponentModel")
            .register_get("id", |m: &mut ModelWrapper| m.id.clone())
            .register_get("position", |m: &mut ModelWrapper| m.position);
            
        // Register Vector3 for direct use in Rhai
        engine.register_type_with_name::<Vector3<f32>>("Vector3")
            .register_fn("new_vector3", |x: f32, y: f32, z: f32| Vector3::new(x, y, z))
            .register_get("x", |v: &mut Vector3<f32>| v.x)
            .register_set("x", |v: &mut Vector3<f32>, val: f32| v.x = val)
            .register_get("y", |v: &mut Vector3<f32>| v.y)
            .register_set("y", |v: &mut Vector3<f32>, val: f32| v.y = val)
            .register_get("z", |v: &mut Vector3<f32>| v.z)
            .register_set("z", |v: &mut Vector3<f32>, val: f32| v.z = val);

        RhaiEngine {
            engine,
            ast_cache: HashMap::new(),
        }
    }

    pub fn load_script(&mut self, path: &str) -> Result<(), Box<rhai::EvalAltResult>> {
        let script_content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let ast = self.engine.compile(script_content)?;
        self.ast_cache.insert(path.to_string(), ast);
        Ok(())
    }

    pub fn execute_component_script(
        &mut self,
        renderer_state: &mut RendererState, // Now read-only
        component: &ComponentData, // Mutably borrow to update script_state
        script_path: &str,
        hook_name: &str,
    ) -> Vec<Command> {
        let ast = if let Some(ast) = self.ast_cache.get(script_path) {
            ast
        } else {
            if self.load_script(script_path).is_err() {
                eprintln!("Failed to load Rhai script: {}", script_path);
                return Vec::new();
            }
            self.ast_cache.get(script_path).unwrap()
        };

        let mut scope = Scope::new();

        match component.kind.as_ref().unwrap() {
            crate::helpers::saved_data::ComponentKind::Model => {
                if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == component.id) {
                    let wrapper = ModelWrapper {
                        id: model.id.clone(),
                        position: model.meshes[0].transform.position,
                    };
                    // Prepare script_state to pass into Rhai. Convert HashMap<String, String> to rhai::Map
                    let mut rhai_script_state = rhai::Map::new();
                    if let Some(current_state) = &model.script_state {
                        for (key, value) in current_state {
                            rhai_script_state.insert(key.clone().into(), value.clone().into());
                        }
                    }
                    
                    match self.engine.call_fn::<rhai::Array>(&mut scope, &ast, hook_name, (wrapper, rhai_script_state)) {
                        Ok(mut result_array) => {
                            // Expect the script to return an array: [commands_array, new_script_state_map]
                            if result_array.len() == 2 {
                                let commands_array = result_array.remove(0);
                                let new_script_state_map = result_array.remove(0);

                                // Update model.script_state with the live map
                                if let Some(map) = new_script_state_map.try_cast::<rhai::Map>() {
                                    let mut updated_hashmap = HashMap::new();
                                    for (key, value) in map {
                                        if let s_key = key.to_string() {
                                            updated_hashmap.insert(s_key, value.to_string());
                                        }
                                    }
                                    model.script_state = Some(updated_hashmap);
                                } else {
                                    eprintln!("Rhai script hook '{}' did not return a valid script_state map.", hook_name);
                                }

                                if let Some(cmds_array) = commands_array.try_cast::<rhai::Array>() {
                                    return cmds_array.into_iter().filter_map(|c| c.try_cast::<Command>()).collect();
                                } else {
                                    eprintln!("Rhai script hook '{}' did not return a valid commands array.", hook_name);
                                }
                            } else {
                                eprintln!("Rhai script hook '{}' did not return expected array [commands_array, new_script_state_map].", hook_name);
                            }
                        }
                        Err(e) => {
                            if !matches!(*e, rhai::EvalAltResult::ErrorFunctionNotFound(_, _)) {
                                eprintln!("Error executing hook '{}' in Rhai script for component {}: {:?}", hook_name, component.id, e);
                            }
                        }
                    }
                }
            },
            _ => {}
        }
        
        Vec::new()
    }
}
