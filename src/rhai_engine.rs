use rhai::{Engine, Scope, AST, Dynamic, Array, CustomType, TypeBuilder};
use std::collections::HashMap;
use std::fs;
use std::rc::Rc;
use std::cell::RefCell;
use nalgebra::Vector3;

use crate::core::RendererState::RendererState;
use crate::helpers::saved_data::ComponentData;
use crate::game_behaviors::dialogue_state::{DialogueState, DialogueOption};
use crate::helpers::saved_data::ComponentKind;

#[derive(Clone, CustomType, Debug)]            // <- auto-implement 'CustomType'
pub struct Vec3 {                       //    for normal structs
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Clone, CustomType, Debug)]            // <- auto-implement 'CustomType'
pub struct Vec4 {                       //    for normal structs
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[derive(Clone, Debug)]
pub struct ScriptParticleConfig {
    pub emission_rate: f32,
    pub life_time: f32,
    pub radius: f32,
    pub gravity: Vector3<f32>,
    pub initial_speed_min: f32,
    pub initial_speed_max: f32,
    pub start_color: [f32; 4],
    pub end_color: [f32; 4],
    pub size: f32,
    pub mode: f32,
    pub position: Vector3<f32>,
}

#[derive(Clone)]
pub struct SystemWrapper {
    pub particle_spawns: Rc<RefCell<Vec<ScriptParticleConfig>>>,
}

impl SystemWrapper {
    pub fn new() -> Self {
        Self {
            particle_spawns: Rc::new(RefCell::new(Vec::new())),
        }
    }

    pub fn debug_name(&mut self, pos: f32) -> String {
        // "SystemWrapper".to_string()
        format!("SystemWrapper! {:?}", pos)
    }

    pub fn vec3(&mut self, x: f32, y: f32, z: f32) -> Vec3 {
        println!("SystemWrapper::vec3 called with: {}, {}, {}", x, y, z);

        Vec3 { x, y, z }
    }
    
    pub fn log_particles(&mut self, 
        position: Vec3, 
        color: Vec4, 
        gravity: Vec3
    ) -> String {
        // format!("Spawn! {:?} {:?} {:?}", position, color, gravity)
        "Anything".to_string()
    }

    // pub fn spawn_particles(&mut self, 
    //     position: Array, 
    //     color: Array, 
    //     gravity: Array
    // ) {
    //     println!("Spawn particles called!");
        
    //     // Convert position array to Vector3
    //     let pos = if position.len() == 3 {
    //         Vector3::new(
    //             position[0].as_float().unwrap_or(0.0) as f32,
    //             position[1].as_float().unwrap_or(0.0) as f32,
    //             position[2].as_float().unwrap_or(0.0) as f32,
    //         )
    //     } else {
    //         Vector3::zeros()
    //     };
        
    //     // Convert gravity array to Vector3
    //     let grav = if gravity.len() == 3 {
    //         Vector3::new(
    //             gravity[0].as_float().unwrap_or(0.0) as f32,
    //             gravity[1].as_float().unwrap_or(0.0) as f32,
    //             gravity[2].as_float().unwrap_or(0.0) as f32,
    //         )
    //     } else {
    //         Vector3::new(0.0, -9.8, 0.0)
    //     };
        
    //     // Convert color array
    //     let start_color = if color.len() >= 3 {
    //         [
    //             color[0].as_float().unwrap_or(1.0) as f32,
    //             color[1].as_float().unwrap_or(1.0) as f32,
    //             color[2].as_float().unwrap_or(1.0) as f32,
    //             if color.len() > 3 { color[3].as_float().unwrap_or(1.0) as f32 } else { 1.0 }
    //         ]
    //     } else {
    //         [1.0, 0.0, 0.0, 1.0]
    //     };

    //     let config = ScriptParticleConfig {
    //         emission_rate: 100.0,
    //         life_time: 2.0,
    //         radius: 5.0,
    //         gravity: grav,
    //         initial_speed_min: 2.0,
    //         initial_speed_max: 5.0,
    //         start_color: start_color,
    //         end_color: [start_color[0], start_color[1], start_color[2], 0.0],
    //         size: 0.2,
    //         mode: 0.0, // Continuous
    //         position: pos,
    //     };
    //     self.particle_spawns.borrow_mut().push(config);
    // }

    pub fn spawn_particles(&mut self, 
        position: Vec3, 
        color: Vec4, 
        gravity: Vec3
    ) {
        println!("Spawn particles called!");
        
        // Convert to nalgebra Vector3
        let pos = Vector3::new(position.x, position.y, position.z);
        let grav = Vector3::new(gravity.x, gravity.y, gravity.z);
        let start_color = [color.x, color.y, color.z, color.w];

        let config = ScriptParticleConfig {
            emission_rate: 100.0,
            life_time: 2.0,
            radius: 2.0,
            gravity: grav,
            initial_speed_min: 2.0,
            initial_speed_max: 5.0,
            start_color: start_color,
            end_color: [start_color[0], start_color[1], start_color[2], 0.0],
            size: 0.2,
            mode: 0.0,
            position: pos,
        };
        self.particle_spawns.borrow_mut().push(config);
    }
}

#[derive(Clone)]
pub struct PlayerWrapper {
    pub id: String,
    pub equipped_weapon_id: String,
    pub equipped_weapon_name: String,
    pub position: Vector3<f32>,
}

impl PlayerWrapper {
    pub fn get_equipped_weapon_id(&mut self) -> String {
        self.equipped_weapon_id.clone()
    }

    pub fn get_equipped_weapon_name(&mut self) -> String {
        self.equipped_weapon_name.clone()
    }
    
    // pub fn get_position(&mut self) -> Vector3<f32> {
    //     self.position.clone()
    // }

    // Return an array instead of Vector3
    // pub fn get_position(&mut self) -> rhai::Array {
    //     vec![
    //         Dynamic::from(self.position.x),
    //         Dynamic::from(self.position.y),
    //         Dynamic::from(self.position.z),
    //     ]
    // }

    pub fn get_position(&mut self) -> Vec3 {
        Vec3 {
            x: self.position.x,
            y: self.position.y,
            z: self.position.z,
        }
    }
}


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

        engine.build_type::<Vec3>();
        engine.build_type::<Vec4>();

        // Register constructor functions
        engine.register_fn("vec3", |x: f32, y: f32, z: f32| {
            println!("vec3 called with: {}, {}, {}", x, y, z);

            Vec3 { x, y, z }
        });
        engine.register_fn("vec4", |x: f32, y: f32, z: f32, w: f32| Vec4 { x, y, z, w });

        // Register the ModelWrapper with mutation methods
        engine.register_type_with_name::<ModelWrapper>("ComponentModel")
            .register_get("id", |m: &mut ModelWrapper| m.id.clone())
            .register_get("position", |m: &mut ModelWrapper| m.position)
            .register_fn("set_position", ModelWrapper::set_position);
            
        // Register Vector3 for direct use in Rhai
        // engine.register_type_with_name::<Vector3<f32>>("Vector3")
        //     .register_fn("new_vector3", |x: f32, y: f32, z: f32| {
        //         println!("new_vector3 {:?} {:?} {:?}", x, y, z);
        //         Vector3::new(x, y, z)
        //     })
        //     .register_get("x", |v: &mut Vector3<f32>| v.x)
        //     .register_set("x", |v: &mut Vector3<f32>, val: f32| v.x = val)
        //     .register_get("y", |v: &mut Vector3<f32>| v.y)
        //     .register_set("y", |v: &mut Vector3<f32>, val: f32| v.y = val)
        //     .register_get("z", |v: &mut Vector3<f32>| v.z)
        //     .register_set("z", |v: &mut Vector3<f32>, val: f32| v.z = val);

        // Register DialogueWrapper
        engine.register_type_with_name::<DialogueWrapper>("Dialogue")
            .register_fn("show", DialogueWrapper::show)
            .register_fn("add_option", DialogueWrapper::add_option)
            .register_fn("set_node", DialogueWrapper::set_node)
            .register_fn("get_node", DialogueWrapper::get_node)
            .register_fn("close", DialogueWrapper::close);

        // Register SystemWrapper
        // engine.register_type_with_name::<SystemWrapper>("System")
        //     .register_fn("spawn_particles", SystemWrapper::spawn_particles)
        engine.register_type_with_name::<SystemWrapper>("System")
            .register_fn("spawn_particles", SystemWrapper::spawn_particles)
            .register_fn("log_particles", SystemWrapper::log_particles)
            .register_fn("debug_name", SystemWrapper::debug_name)
            .register_fn("vec3", SystemWrapper::vec3);

        // engine
        //     .register_type_with_name::<Rc<RefCell<SystemWrapper>>>("System")
        //     .register_fn(
        //         "spawn_particles",
        //         |sys: &mut Rc<RefCell<SystemWrapper>>,
        //         position: Vector3<f32>,
        //         color: Array,
        //         gravity: Vector3<f32>| {
        //             sys.borrow_mut().spawn_particles(position, color, gravity);
        //         }
        //     )
        //     .register_fn(
        //         "log_particles",
        //         |sys: &mut Rc<RefCell<SystemWrapper>>,
        //         position: Vector3<f32>,
        //         color: Array,
        //         gravity: Vector3<f32>| {
        //             sys.borrow_mut().log_particles(position, color, gravity);
        //         }
        //     );

        // Register PlayerWrapper
        engine.register_type_with_name::<PlayerWrapper>("PlayerCharacter")
            .register_fn("get_equipped_weapon_id", PlayerWrapper::get_equipped_weapon_id)
            .register_fn("get_equipped_weapon_name", PlayerWrapper::get_equipped_weapon_name)
            .register_fn("get_position", PlayerWrapper::get_position);

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
        let mut system = SystemWrapper::new();
        // let system = Rc::new(RefCell::new(SystemWrapper::new()));
        // scope.push("system", system.clone());

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
                    
                    match self.engine.call_fn::<Dynamic>(&mut scope, &ast, hook_name, (wrapper.clone(), system.clone(), rhai_script_state)) {
                        Ok(result) => {
                            // Script returns just the updated script_state map
                            if let Some(map) = result.try_cast::<rhai::Map>() {
                                let mut updated_hashmap = HashMap::new();
                                for (key, value) in map {
                                    updated_hashmap.insert(key.to_string(), value.to_string());
                                }
                                model.script_state = Some(updated_hashmap);
                            }
                            
                            let particle_spawns = system.particle_spawns.borrow().clone();

                            // Check if wrapper was mutated
                            if wrapper.position_changed || !particle_spawns.is_empty() {
                                return Some(ComponentChanges {
                                    component_id: wrapper.id,
                                    new_position: if wrapper.position_changed { Some(wrapper.position) } else { None },
                                    particle_spawns: if !particle_spawns.is_empty() { Some(particle_spawns) } else { None },
                                });
                            }
                        }
                        Err(e) => {
                            // if !matches!(*e, rhai::EvalAltResult::ErrorFunctionNotFound(_, _)) {
                                eprintln!("Error executing hook '{}' in Rhai script for component {}: {:?}", hook_name, component.id, e);
                            // }
                        }
                    }
                }
            },
            crate::helpers::saved_data::ComponentKind::PlayerCharacter => {
                if let Some(player) = &mut renderer_state.player_character {
                    // Assuming player model position or camera position
                    // We need a wrapper for player
                    let wrapper = PlayerWrapper {
                        id: component.id.clone(),
                        equipped_weapon_name: if let Some(weapon) = &player.inventory.equipped_weapon {
                            weapon.generic_properties.name.clone()
                        } else {
                            "".to_string()
                        },
                        equipped_weapon_id: if let Some(weapon) = &player.inventory.equipped_weapon {
                            weapon.id.clone()
                        } else {
                            "".to_string()
                        },
                        position: if let Some(rigidbody) = &player.movement_rigid_body_handle {
                            let body = renderer_state.rigid_body_set.get(*rigidbody);
                            let body = body.as_ref().expect("Couldn't get body");

                            Vector3::new(body.translation().x, body.translation().y, body.translation().z)
                        } else {
                            Vector3::zeros()
                        }
                    };
                    
                    // Prepare script_state
                    let mut rhai_script_state = rhai::Map::new();
                    if let Some(current_state) = &player.script_state {
                        for (key, value) in current_state {
                            rhai_script_state.insert(key.clone().into(), value.clone().into());
                        }
                    }

                    // Call Rhai function
                     match self.engine.call_fn::<Dynamic>(&mut scope, &ast, hook_name, (wrapper.clone(), system.clone(), rhai_script_state)) {
                        Ok(result) => {
                             // Script returns just the updated script_state map
                            if let Some(map) = result.try_cast::<rhai::Map>() {
                                let mut updated_hashmap = HashMap::new();
                                for (key, value) in map {
                                    updated_hashmap.insert(key.to_string(), value.to_string());
                                }
                                player.script_state = Some(updated_hashmap);
                            }

                             let particle_spawns = system.particle_spawns.borrow().clone();

                            if !particle_spawns.is_empty() {
                                return Some(ComponentChanges {
                                    component_id: wrapper.id,
                                    new_position: None,
                                    particle_spawns: Some(particle_spawns),
                                });
                            }
                        },
                        Err(e) => {
                            //  if !matches!(*e, rhai::EvalAltResult::ErrorFunctionNotFound(_, _)) {
                                eprintln!("Error executing hook '{}' in Rhai script for component {}: {:?}", hook_name, component.id, e);
                            // }
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
        renderer_state: &mut RendererState,
        dialogue_state: &mut DialogueState,
        // component: &ComponentData, // Potentially use this for persistent state later
        script_path: &str,
        hook_name: &str,
    ) {
        // Set NPC is_talking to true
        if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.model_id == dialogue_state.current_npc_id) {
             npc.is_talking = true;
        }

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
        
        // Call the function, passing wrapper as argument
        match self.engine.call_fn::<DialogueWrapper>(&mut scope, &ast, hook_name, (wrapper,)) {
            Ok(updated_wrapper) => {
                if updated_wrapper.changed {
                    dialogue_state.current_text = updated_wrapper.text;
                    dialogue_state.options = updated_wrapper.options;
                    dialogue_state.is_open = updated_wrapper.is_open;
                    dialogue_state.npc_name = updated_wrapper.npc_name;
                    dialogue_state.current_node = updated_wrapper.current_node;
                    dialogue_state.selected_option_index = 0;
                    dialogue_state.ui_dirty = true;
                    
                    if !dialogue_state.is_open {
                        if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.model_id == dialogue_state.current_npc_id) {
                            npc.is_talking = false;
                        }
                    }
                }
            },
            Err(e) => {
                // if !matches!(*e, rhai::EvalAltResult::ErrorFunctionNotFound(_, _)) {
                    eprintln!("Error executing hook '{}': {:?}", hook_name, e);
                // }
            }
        }
    }
}

// Simple struct to track what changed
pub struct ComponentChanges {
    pub component_id: String,
    pub new_position: Option<Vector3<f32>>,
    pub particle_spawns: Option<Vec<ScriptParticleConfig>>,
}