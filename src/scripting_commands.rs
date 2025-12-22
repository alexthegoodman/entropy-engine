use rhai::CustomType;

#[derive(Debug, Clone)]
pub enum Command {
    SetPosition { component_id: String, position: [f32; 3] },
}

impl Command {
    pub fn new_set_position(component_id: String, position: rhai::Array) -> Result<Self, Box<rhai::EvalAltResult>> {
        if position.len() == 3 {
            let pos = [
                position[0].as_float().unwrap_or(0.0) as f32,
                position[1].as_float().unwrap_or(0.0) as f32,
                position[2].as_float().unwrap_or(0.0) as f32,
            ];
            Ok(Command::SetPosition { component_id, position: pos })
        } else {
            Err("Position must be an array of 3 numbers".into())
        }
    }
}

impl CustomType for Command {
    fn build(mut builder: rhai::TypeBuilder<Self>) {
        builder
            .with_name("Command")
            .with_fn("new_set_position", Self::new_set_position);
    }
}
