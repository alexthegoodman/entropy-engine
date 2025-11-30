pub trait Node {
    fn new() -> Self
    where
        Self: Sized;
    fn on_frame(&mut self, context: &mut EngineContext, delta_time: f32);
}
