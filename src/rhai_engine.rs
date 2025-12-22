use rhai::{Engine, Scope, AST, Dynamic, Array};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use crate::helpers::saved_data::{ComponentData, GenericProperties};

pub struct RhaiEngine {
    engine: Engine,
}

impl RhaiEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();
        
        // Register a print function
        engine.on_print(|text| {
            println!("[RHAI] {}", text);
        });

        // Registering ComponentData API
        engine
            .register_type_with_name::<ComponentData>("Component")
            .register_get("id", |c: &mut ComponentData| c.id.clone())
            .register_get("position", |c: &mut ComponentData| {
                // Rhai works well with Vec<f32>
                c.generic_properties.position.iter().map(|&f| Dynamic::from_float(f)).collect::<Array>()
            })
            .register_fn("set_position", |c: &mut ComponentData, pos: Array| {
                if pos.len() == 3 {
                    c.generic_properties.position = [
                        pos[0].as_float().unwrap_or(0.0),
                        pos[1].as_float().unwrap_or(0.0),
                        pos[2].as_float().unwrap_or(0.0),
                    ];
                }
            })
            .register_fn("get_script_state", |c: &mut ComponentData, key: &str| {
                c.script_state.as_ref().and_then(|s| s.get(key).cloned()).map(Dynamic::from)
                    .unwrap_or(Dynamic::UNIT)
            })
            .register_fn("set_script_state", |c: &mut ComponentData, key: &str, value: Dynamic| {
                let state = c.script_state.get_or_insert_with(HashMap::new);
                state.insert(key.to_string(), value.to_string());
            });

        RhaiEngine {
            engine,
        }
    }

    pub fn load_global_scripts(&mut self, script_paths: &Option<Vec<String>>) {
        if let Some(paths) = script_paths {
            for path_str in paths {
                let path = Path::new(path_str);
                if path.exists() {
                    if let Ok(script_content) = fs::read_to_string(path) {
                        if let Err(e) = self.engine.run(&script_content) {
                            eprintln!("Error executing global Rhai script {}: {:?}", path_str, e);
                        }
                    } else {
                        eprintln!("Error reading global Rhai script: {}", path_str);
                    }
                } else {
                    eprintln!("Global Rhai script not found: {}", path_str);
                }
            }
        }
    }

    pub fn execute_component_script(
        &mut self,
        component: &mut ComponentData,
        script_path: &str,
        hook_name: &str,
    ) {
        let path = Path::new(script_path);
        if path.exists() {
            if let Ok(script_content) = fs::read_to_string(path) {
                let mut scope = Scope::new();
                scope.push("component", component);

                if let Ok(ast) = self.engine.compile(&script_content) {
                    if let Err(e) = self.engine.call_fn(&mut scope, &ast, hook_name, ()) {
                        // It's common for a script not to have all hooks, so we can ignore 'FunctionNotFound'
                        if !matches!(*e, rhai::EvalAltResult::ErrorFunctionNotFound(_, _)) {
                            eprintln!("Error executing hook '{}' in Rhai script for component {}: {:?}", hook_name, scope.get_value::<&mut ComponentData>("component").unwrap().id, e);
                        }
                    }
                }
            }
        }
    }
}
