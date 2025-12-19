pub struct AnimationState {
    pub animation_index: usize,
    pub current_time: f32,
    pub is_playing: bool,
    pub speed: f32,
}

impl AnimationState {
    pub fn new(animation_index: usize) -> Self {
        Self {
            animation_index,
            current_time: 0.0,
            is_playing: true,
            speed: 1.0,
        }
    }

    pub fn update(&mut self, delta_time: f32) {
        if self.is_playing {
            self.current_time += delta_time * self.speed;
        }
    }
}
