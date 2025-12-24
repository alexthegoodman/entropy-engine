use rhai::{Engine, Scope, AST, Dynamic, Array, CustomType, TypeBuilder};
use std::collections::HashMap;
use std::fs;
use nalgebra::Vector3;

use crate::core::RendererState::RendererState;
use crate::helpers::saved_data::ComponentData;
use crate::game_behaviors::dialogue_state::{DialogueState, DialogueOption};

#[derive(Clone)]
pub struct ModelWrapper {
    pub id: String,
    pub position: Vector3<f32>,
    pub position_changed: bool,
}

impl ModelWrapper {
    pub fn set_position(&mut self, pos: Array) {
        if pos.len() == 3 {
            self.position = Vector3::new(
                pos[0].as_float().unwrap_or(0.0) as f32,
                pos[1].as_float().unwrap_or(0.0) as f32,
                pos[2].as_float().unwrap_or(0.0) as f32,
            );
            self.position_changed = true;
        }
    }
}

#[derive(Clone)]
pub struct DialogueWrapper {
    pub text: String,
    pub options: Vec<DialogueOption>,
    pub changed: bool,
    pub is_open: bool,
    pub npc_name: String,
    pub current_node: String,
}

impl DialogueWrapper {
    pub fn show(&mut self, text: String) {
        self.text = text;
        self.options.clear();
        self.changed = true;
        self.is_open = true;
    }

    pub fn add_option(&mut self, text: String, next_node: String) {
        self.options.push(DialogueOption { text, next_node });
        self.changed = true;
    }

    pub fn set_node(&mut self, node: String) {
        self.current_node = node;
        self.changed = true;
    }

    pub fn close(&mut self) {
        self.is_open = false;
        self.changed = true;
    }

    pub fn get_node(&mut self) -> String {
        self.current_node.clone()
    }
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

        // Register the ModelWrapper with mutation methods
        engine.register_type_with_name::<ModelWrapper>("ComponentModel")
            .register_get("id", |m: &mut ModelWrapper| m.id.clone())
            .register_get("position", |m: &mut ModelWrapper| m.position)
            .register_fn("set_position", ModelWrapper::set_position);
            
        // Register Vector3 for direct use in Rhai
        engine.register_type_with_name::<Vector3<f32>>("Vector3")
            .register_fn("new_vector3", |x: f32, y: f32, z: f32| Vector3::new(x, y, z))
            .register_get("x", |v: &mut Vector3<f32>| v.x)
            .register_set("x", |v: &mut Vector3<f32>, val: f32| v.x = val)
            .register_get("y", |v: &mut Vector3<f32>| v.y)
            .register_set("y", |v: &mut Vector3<f32>, val: f32| v.y = val)
            .register_get("z", |v: &mut Vector3<f32>| v.z)
            .register_set("z", |v: &mut Vector3<f32>, val: f32| v.z = val);

        // Register DialogueWrapper
        engine.register_type_with_name::<DialogueWrapper>("Dialogue")
            .register_fn("show", DialogueWrapper::show)
            .register_fn("add_option", DialogueWrapper::add_option)
            .register_fn("set_node", DialogueWrapper::set_node)
            .register_fn("get_node", DialogueWrapper::get_node)
            .register_fn("close", DialogueWrapper::close);

        RhaiEngine {
            engine,
            ast_cache: HashMap::new(),
        }
    }

    pub fn load_script(&mut self, path: &str) -> Result<(), Box<rhai::EvalAltResult>> {
        let script_content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let ast = self.engine.compile(script_content)?;
        println!("load script");
        self.ast_cache.insert(path.to_string(), ast);
        Ok(())
    }

    pub fn execute_component_script(
        &mut self,
        renderer_state: &mut RendererState,
        component: &ComponentData,
        script_path: &str,
        hook_name: &str,
    ) -> Option<ComponentChanges> {
        let ast = if let Some(ast) = self.ast_cache.get(script_path) {
            ast
        } else {
            if self.load_script(script_path).is_err() {
                eprintln!("Failed to load Rhai script: {}", script_path);
                return None;
            }
            self.ast_cache.get(script_path).unwrap()
        };

        let mut scope = Scope::new();

        match component.kind.as_ref().unwrap() {
            crate::helpers::saved_data::ComponentKind::Model => {
                if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == component.id) {
                    let mut wrapper = ModelWrapper {
                        id: model.id.clone(),
                        position: model.meshes[0].transform.position,
                        position_changed: false,
                    };
                    
                    // Prepare script_state
                    let mut rhai_script_state = rhai::Map::new();
                    if let Some(current_state) = &model.script_state {
                        for (key, value) in current_state {
                            rhai_script_state.insert(key.clone().into(), value.clone().into());
                        }
                    }
                    
                    match self.engine.call_fn::<Dynamic>(&mut scope, &ast, hook_name, (wrapper.clone(), rhai_script_state)) {
                        Ok(result) => {
                            // Script returns just the updated script_state map
                            if let Some(map) = result.try_cast::<rhai::Map>() {
                                let mut updated_hashmap = HashMap::new();
                                for (key, value) in map {
                                    updated_hashmap.insert(key.to_string(), value.to_string());
                                }
                                model.script_state = Some(updated_hashmap);
                            }

                            // Check if wrapper was mutated
                            if wrapper.position_changed {
                                return Some(ComponentChanges {
                                    component_id: wrapper.id,
                                    new_position: Some(wrapper.position),
                                });
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
        
        None
    }
    
    pub fn execute_interaction_script(
        &mut self,
        dialogue_state: &mut DialogueState,
        script_path: &str,
        hook_name: &str,
    ) {
        let ast = if let Some(ast) = self.ast_cache.get(script_path) {
            ast
        } else {
            if self.load_script(script_path).is_err() {
                eprintln!("Failed to load Rhai script: {}", script_path);
                return;
            }
            self.ast_cache.get(script_path).unwrap()
        };

        let wrapper = DialogueWrapper {
            text: dialogue_state.current_text.clone(),
            options: dialogue_state.options.clone(),
            changed: false,
            is_open: dialogue_state.is_open,
            npc_name: dialogue_state.npc_name.clone(),
            current_node: dialogue_state.current_node.clone(),
        };

        let mut scope = Scope::new();

        println!("Call fn! {:?} {:?}", wrapper.changed, wrapper.text);
        
        // Call the function, passing wrapper as argument
        match self.engine.call_fn::<DialogueWrapper>(&mut scope, &ast, hook_name, (wrapper,)) {
            Ok(updated_wrapper) => {
                println!("Called fn {:?} {:?}", updated_wrapper.changed, updated_wrapper.text);
                if updated_wrapper.changed {
                    dialogue_state.current_text = updated_wrapper.text;
                    dialogue_state.options = updated_wrapper.options;
                    dialogue_state.is_open = updated_wrapper.is_open;
                    dialogue_state.npc_name = updated_wrapper.npc_name;
                    dialogue_state.current_node = updated_wrapper.current_node;
                    dialogue_state.ui_dirty = true;
                }
            },
            Err(e) => {
                if !matches!(*e, rhai::EvalAltResult::ErrorFunctionNotFound(_, _)) {
                    eprintln!("Error executing hook '{}': {:?}", hook_name, e);
                }
            }
        }
    }
}

// Simple struct to track what changed
pub struct ComponentChanges {
    pub component_id: String,
    pub new_position: Option<Vector3<f32>>,
}
