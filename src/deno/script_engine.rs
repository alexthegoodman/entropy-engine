use deno_core::{
    error::AnyError,
    op2,
    extension,
    JsRuntime,
    RuntimeOptions,
    serde_v8,
    v8,
    OpState,
    Extension,
    ModuleSpecifier,
    ascii_str,
    FsModuleLoader,
    ModuleId,
};
use std::rc::Rc;
use std::cell::RefCell;
use std::path::Path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use nalgebra::Vector3;

use crate::core::RendererState::RendererState;
use crate::helpers::saved_data::ComponentData;
use crate::game_ui::dialogue_state::{DialogueState, DialogueOption};
use crate::helpers::saved_data::ComponentKind;
use crate::helpers::utilities::get_scripts_dir;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Vec4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScriptParticleConfig {
    pub emission_rate: f32,
    pub life_time: f32,
    pub radius: f32,
    pub gravity: Vec3,
    pub initial_speed_min: f32,
    pub initial_speed_max: f32,
    pub start_color: [f32; 4],
    pub end_color: [f32; 4],
    pub size: f32,
    pub mode: f32,
    pub position: Vec3,
}

pub struct ComponentChanges {
    pub component_id: String,
    pub new_position: Option<Vec3>,
    pub particle_spawns: Option<Vec<ScriptParticleConfig>>,
}

struct EngineContext {
    pub particle_spawns: Vec<ScriptParticleConfig>,
    pub dialogue_wrapper: Option<DialogueWrapper>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DialogueWrapper {
    pub text: String,
    pub options: Vec<DialogueOption>,
    pub changed: bool,
    pub is_open: bool,
    pub npc_name: String,
    pub current_node: String,
    pub started_quest: Option<String>,
}

#[op2]
#[serde]
fn op_vec3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

#[op2]
#[serde]
fn op_vec4(x: f32, y: f32, z: f32, w: f32) -> Vec4 {
    Vec4 { x, y, z, w }
}

#[op2]
fn op_system_spawn_particles(state: &mut OpState, #[serde] pos: Vec3, #[serde] color: Vec4, #[serde] gravity: Vec3) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
        let start_color = [color.x, color.y, color.z, color.w];
        let end_color = [color.x, color.y, color.z, 0.0];
        
        let config = ScriptParticleConfig {
            emission_rate: 100.0,
            life_time: 3.0,
            radius: 0.6,
            gravity,
            initial_speed_min: 2.0,
            initial_speed_max: 5.0,
            start_color,
            end_color,
            size: 0.02,
            mode: 0.0,
            position: pos,
        };
        ctx.particle_spawns.push(config);
    }
}

#[op2(fast)]
fn op_dialogue_show(state: &mut OpState, #[string] text: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
        if let Some(d) = &mut ctx.dialogue_wrapper {
            d.text = text;
            d.options.clear();
            d.changed = true;
            d.is_open = true;
        }
    }
}

#[op2(fast)]
fn op_dialogue_add_option(state: &mut OpState, #[string] text: String, #[string] next_node: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.options.push(DialogueOption { text, next_node });
            d.changed = true;
        }
    }
}

#[op2(fast)]
fn op_dialogue_start_quest(state: &mut OpState, #[string] quest_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.started_quest = Some(quest_id);
        }
    }
}

#[op2(fast)]
fn op_dialogue_close(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.is_open = false;
            d.changed = true;
        }
    }
}

#[op2]
#[string]
fn op_dialogue_get_node(state: &mut OpState) -> String {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &ctx.dialogue_wrapper {
            return d.current_node.clone();
        }
    }
    "".to_string()
}

#[op2(fast)]
fn op_println(
    state: &mut OpState,
    #[string] msg: String
) -> Result<(), deno_error::JsErrorBox> {
    println!("[DENO] {}", msg);
    Ok(())
}

// #[op2]
// fn op_use_state(
//   state: &mut OpState,
//   #[global] callback: v8::Global<v8::Function>,
// ) -> Result<(), deno_error::JsErrorBox> {
//   state.put(callback);
//   Ok(())
// }

// #[op2(fast)]
// fn op_use_state(
//   state: &mut OpState,
// //   #[global] callback: v8::Global<v8::Function>,
// #[string] msg: String
// ) -> Result<(), deno_error::JsErrorBox> {
// //   state.put(callback);
// println!("[DENO]");
//   Ok(())
// }

extension!(
    entropy_engine,
    ops = [
        // op_vec3,
        // op_vec4,
        op_system_spawn_particles,
        op_dialogue_show,
        op_dialogue_add_option,
        op_dialogue_start_quest,
        op_dialogue_close,
        op_dialogue_get_node,
        op_println
    ],
    esm_entry_point = "ext:entropy_engine/setup.js",
    esm = [ dir "src", "setup.js" ],
);

pub struct DenoEngine {
    runtime: JsRuntime,
    pub project_id: Option<String>,
    failed_scripts: HashSet<String>,
    loaded_modules: HashMap<String, ModuleId>,
}

impl DenoEngine {
    pub fn new(project_id: Option<String>) -> Self {
        let loader = Rc::new(FsModuleLoader);
        let ext = entropy_engine::init_ops_and_esm();
        // let ext = entropy_engine::init_ops();
        // println!("ext {:?} {:?} {:?}", ext.enabled, ext.esm_entry_point, ext.esm_files);
        let mut runtime = JsRuntime::new(RuntimeOptions {
            module_loader: Some(loader),
            extensions: vec![
                ext,
            ],
            ..Default::default()
        });

        DenoEngine {
            runtime,
            project_id,
            failed_scripts: HashSet::new(),
            loaded_modules: HashMap::new(),
        }
    }

    pub fn execute_component_script(
        &mut self,
        renderer_state: &mut RendererState,
        component: &ComponentData,
        script_path: &str,
        hook_name: &str,
    ) -> Option<ComponentChanges> {
        if let Some(project_id) = &self.project_id {
        let scripts_path = get_scripts_dir(&project_id);

        if let Some(scripts_path) = scripts_path {
            let script_path = scripts_path.join(script_path);
            let script_str = script_path.to_string_lossy().to_string();

            if self.failed_scripts.contains(&script_str) {
                return None;
            }

            // Prepare context
            let mut context = EngineContext {
                particle_spawns: Vec::new(),
                dialogue_wrapper: None,
            };
            
            self.runtime.op_state().borrow_mut().put(context);

            // Prepare serializable data BEFORE creating v8 values
            #[derive(Serialize)]
            struct PlayerWrapper {
                equipped_weapon_name: String,
                equipped_weapon_id: String,
                position: Vec3,
            }

            #[derive(Serialize)]
            struct ModelWrapper {
                id: String,
                position: Vec3,
            }

            #[derive(Serialize)]
            #[serde(untagged)]
            enum ComponentWrapper {
                Player(PlayerWrapper),
                Model(ModelWrapper),
                None(()),
            }

            let component_data = if component.kind == Some(ComponentKind::PlayerCharacter) {
                if let Some(player) = &renderer_state.player_character {
                    let pos = if let Some(rigidbody) = &player.movement_rigid_body_handle {
                        let body = renderer_state.rigid_body_set.get(*rigidbody);
                        let body = body.as_ref().expect("Couldn't get body");
                        Vec3 { x: body.translation().x, y: body.translation().y, z: body.translation().z }
                    } else {
                        Vec3 { x: 0.0, y: 0.0, z: 0.0 }
                    };

                    ComponentWrapper::Player(PlayerWrapper {
                        equipped_weapon_name: player.inventory.equipped_weapon.as_ref()
                            .map(|w| w.generic_properties.name.clone()).unwrap_or_default(),
                        equipped_weapon_id: player.inventory.equipped_weapon.as_ref()
                            .map(|w| w.id.clone()).unwrap_or_default(),
                        position: pos
                    })
                } else {
                    ComponentWrapper::None(())
                }
            } else if component.kind == Some(ComponentKind::Model) {
                if let Some(model) = renderer_state.models.iter().find(|m| m.id == component.id) {
                    ComponentWrapper::Model(ModelWrapper {
                        id: model.id.clone(),
                        position: Vec3 { 
                            x: model.meshes[0].transform.position.x, 
                            y: model.meshes[0].transform.position.y, 
                            z: model.meshes[0].transform.position.z 
                        }
                    })
                } else {
                    ComponentWrapper::None(())
                }
            } else {
                ComponentWrapper::None(())
            };

            // Get script state
            let mut script_state_map = HashMap::new();
            if component.kind == Some(ComponentKind::Model) {
                if let Some(model) = renderer_state.models.iter().find(|m| m.id == component.id) {
                    if let Some(s) = &model.script_state {
                        script_state_map = s.clone();
                    }
                }
            } else if component.kind == Some(ComponentKind::PlayerCharacter) {
                if let Some(player) = &renderer_state.player_character {
                    if let Some(s) = &player.script_state {
                        script_state_map = s.clone();
                    }
                }
            }
            
            // Execute script
            let module_url = format!("file:///{}", script_str.replace("\"", "/"));
            
            let module_id = if let Some(&id) = self.loaded_modules.get(&module_url) {
                id
            } else {
                let future = async {
                    let module_specifier = ModuleSpecifier::parse(&module_url).map_err(|e| AnyError::from(e))?;
                    let module_id = self.runtime.load_main_es_module(&module_specifier).await?;
                    let _ = self.runtime.mod_evaluate(module_id).await?;
                    Ok::<_, AnyError>(module_id)
                };
                
                match pollster::block_on(future) {
                    Ok(id) => {
                        self.loaded_modules.insert(module_url.clone(), id);
                        id
                    }
                    Err(e) => {
                        eprintln!("Error loading script {}: {}", script_str, e);
                        self.failed_scripts.insert(script_str);
                        return None;
                    }
                }
            };

            let namespace = match self.runtime.get_module_namespace(module_id) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("Error getting namespace for {}: {}", script_str, e);
                    return None;
                }
            };

            // NOW create all v8 values and execute in ONE scope
            let new_state = {
                let global_context = self.runtime.main_context();
                let scope = &mut self.runtime.handle_scope();
                
                // Create v8 values from our prepared data
                let player_wrapper = serde_v8::to_v8(scope, component_data).unwrap();
                let state_arg = serde_v8::to_v8(scope, script_state_map).unwrap();
                
                let namespace_local = v8::Local::new(scope, namespace);
                
                let global = global_context.open(scope).global(scope);
                
                let func_name = v8::String::new(scope, hook_name).unwrap();
                let func_value = namespace_local.get(scope, func_name.into());
                
                if let Some(func_value) = func_value {
                    if func_value.is_function() {
                        let func = v8::Local::<v8::Function>::try_from(func_value).unwrap();
                        
                        // Create System object
                        let create_system_key = v8::String::new(scope, "_createSystem").unwrap();
                        let create_system_val = global.get(scope, create_system_key.into()).unwrap();
                        let create_system_func = v8::Local::<v8::Function>::try_from(create_system_val)
                            .expect("setup.js should define _createSystem");
                        let system_arg = create_system_func.call(scope, global.into(), &[]).unwrap();

                        let args = [player_wrapper, system_arg, state_arg];
                        
                        let result = func.call(scope, global.into(), &args);
                        
                        if let Some(result) = result {
                            serde_v8::from_v8::<HashMap<String, String>>(scope, result).ok()
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            }; // ALL v8 values and scope dropped here

            // Update state in component
            if let Some(new_state) = new_state {
                if component.kind == Some(ComponentKind::Model) {
                    if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == component.id) {
                        model.script_state = Some(new_state);
                    }
                } else if component.kind == Some(ComponentKind::PlayerCharacter) {
                    if let Some(player) = &mut renderer_state.player_character {
                        player.script_state = Some(new_state);
                    }
                }
            }
            
            // Retrieve context changes - NOW we can safely borrow op_state again
            let particle_spawns = {
                let mut op_state = self.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                if let Some(ctx) = op_state.try_borrow_mut::<EngineContext>() {
                    std::mem::take(&mut ctx.particle_spawns)
                } else {
                    Vec::new()
                }
            };

            if !particle_spawns.is_empty() {
                return Some(ComponentChanges {
                    component_id: component.id.clone(),
                    new_position: None,
                    particle_spawns: Some(particle_spawns),
                });
            }
        }
        }
        None
    }

    pub fn execute_interaction_script(
        &mut self,
        renderer_state: &mut RendererState,
        dialogue_state: &mut DialogueState,
        script_path: &str,
        hook_name: &str,
    ) {
                if let Some(project_id) = &self.project_id {

         let scripts_path = get_scripts_dir(&project_id);

        if let Some(scripts_path) = scripts_path {
            let script_path = scripts_path.join(script_path);
            let script_str = script_path.to_string_lossy().to_string();

            if self.failed_scripts.contains(&script_str) {
                return;
            }

            // Prepare context
            let wrapper = DialogueWrapper {
                text: dialogue_state.current_text.clone(),
                options: dialogue_state.options.clone(),
                changed: false,
                is_open: dialogue_state.is_open,
                npc_name: dialogue_state.npc_name.clone(),
                current_node: dialogue_state.current_node.clone(),
                started_quest: None,
            };

            let mut context = EngineContext {
                particle_spawns: Vec::new(),
                dialogue_wrapper: Some(wrapper),
            };
            self.runtime.op_state().borrow_mut().put(context);

            let module_url = format!("file:///{}", script_str.replace("\"", "/"));
            let module_id = if let Some(&id) = self.loaded_modules.get(&module_url) {
                id
            } else {
                let future = async {
                    let module_specifier = ModuleSpecifier::parse(&module_url).map_err(|e| AnyError::from(e))?;
                    let module_id = self.runtime.load_main_es_module(&module_specifier).await?;
                    let _ = self.runtime.mod_evaluate(module_id).await?;
                    Ok::<_, AnyError>(module_id)
                };
                
                match pollster::block_on(future) {
                    Ok(id) => {
                        self.loaded_modules.insert(module_url.clone(), id);
                        id
                    }
                    Err(e) => {
                        eprintln!("Error loading script {}: {}", script_str, e);
                        self.failed_scripts.insert(script_str);
                        return;
                    }
                }
            };

            let namespace = match self.runtime.get_module_namespace(module_id) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("Error getting namespace for {}: {}", script_str, e);
                    return;
                }
            };

            {
                let global_context = self.runtime.main_context();
                let scope = &mut self.runtime.handle_scope();
                let namespace_local = v8::Local::new(scope, namespace);
                
                let global = global_context.open(scope).global(scope);
                
                let func_name = v8::String::new(scope, hook_name).unwrap();
                let func_value = namespace_local.get(scope, func_name.into());

                if let Some(func_value) = func_value {
                    if func_value.is_function() {
                        let func = v8::Local::<v8::Function>::try_from(func_value).unwrap();
                        
                        // Create Dialogue object via JS helper
                        let create_dialogue_key = v8::String::new(scope, "_createDialogue").unwrap();
                        let create_dialogue_val = global.get(scope, create_dialogue_key.into()).unwrap();
                        let create_dialogue_func = v8::Local::<v8::Function>::try_from(create_dialogue_val).expect("setup.js should define _createDialogue");
                        let dialogue_arg = create_dialogue_func.call(scope, global.into(), &[]).unwrap();

                        let args = [dialogue_arg];
                        let _ = func.call(scope, global.into(), &args);
                    }
                }
            }

             // Retrieve changes
             {
                let mut op_state = self.runtime.op_state();
                 let mut op_state = op_state.borrow_mut();
                 if let Some(mut ctx) = op_state.try_borrow_mut::<EngineContext>() {
                     if let Some(d) = &mut ctx.dialogue_wrapper {
                          if let Some(quest_id) = &d.started_quest {
                            renderer_state.quest_state.start_quest(quest_id);
                        }

                        if d.changed {
                            dialogue_state.current_text = d.text.clone();
                            dialogue_state.options = d.options.clone();
                            dialogue_state.is_open = d.is_open;
                            dialogue_state.npc_name = d.npc_name.clone();
                            dialogue_state.current_node = d.current_node.clone();
                            dialogue_state.selected_option_index = 0;
                            dialogue_state.ui_dirty = true;
                            
                            if !dialogue_state.is_open {
                                 if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.model_id == dialogue_state.current_npc_id) {
                                    npc.is_talking = false;
                                }
                            }
                        }
                     }
                 }
             }
        }
    }
    }
}
