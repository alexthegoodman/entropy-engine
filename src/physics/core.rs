use std::f32::consts::PI;

/// 3D Vector for positions and velocities
#[derive(Debug, Clone, Copy)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    pub fn zero() -> Self {
        Self::new(0.0, 0.0, 0.0)
    }

    pub fn length(&self) -> f32 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    pub fn normalize(&self) -> Self {
        let len = self.length();
        if len > 0.0 {
            Self::new(self.x / len, self.y / len, self.z / len)
        } else {
            *self
        }
    }

    pub fn dot(&self, other: &Vec3) -> f32 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }
}

impl std::ops::Add for Vec3 {
    type Output = Vec3;
    fn add(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }
}

impl std::ops::Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }
}

impl std::ops::Mul<f32> for Vec3 {
    type Output = Vec3;
    fn mul(self, scalar: f32) -> Vec3 {
        Vec3::new(self.x * scalar, self.y * scalar, self.z * scalar)
    }
}

/// Heightfield terrain representation
pub struct Heightfield {
    pub width: usize,
    pub height: usize,
    pub heights: Vec<f32>,
    pub scale_x: f32,
    pub scale_z: f32,
    pub offset: Vec3,
}

impl Heightfield {
    /// Create from height values in row-major order
    pub fn from_heights(width: usize, height: usize, heights: Vec<f32>, scale_x: f32, scale_z: f32) -> Self {
        assert_eq!(heights.len(), width * height, "Height data must match dimensions");
        Self { 
            width, 
            height, 
            heights, 
            scale_x, 
            scale_z,
            offset: Vec3::zero(),
        }
    }

    /// Create from vertices (extracts Y component as height)
    pub fn from_vertices(width: usize, height: usize, vertices: Vec<Vec3>) -> Self {
        assert_eq!(vertices.len(), width * height, "Vertex data must match dimensions");
        let heights: Vec<f32> = vertices.iter().map(|v| v.y).collect();
        let scale_x = if width > 1 { (vertices[1].x - vertices[0].x).abs() } else { 1.0 };
        let scale_z = if height > 1 { (vertices[width].z - vertices[0].z).abs() } else { 1.0 };
        let offset = vertices[0];
        
        Self { 
            width, 
            height, 
            heights, 
            scale_x, 
            scale_z,
            offset,
        }
    }

    /// Set world-space offset for this terrain
    pub fn with_offset(mut self, offset: Vec3) -> Self {
        self.offset = offset;
        self
    }

    /// Get height at grid coordinates
    fn get_height(&self, x: usize, z: usize) -> f32 {
        if x < self.width && z < self.height {
            self.heights[z * self.width + x]
        } else {
            f32::NEG_INFINITY
        }
    }

    /// Check if world position is within this terrain's bounds
    pub fn contains_point(&self, world_x: f32, world_z: f32) -> bool {
        let local_x = world_x - self.offset.x;
        let local_z = world_z - self.offset.z;
        let grid_x = local_x / self.scale_x;
        let grid_z = local_z / self.scale_z;
        
        grid_x >= 0.0 && grid_z >= 0.0 && 
        grid_x < (self.width - 1) as f32 && 
        grid_z < (self.height - 1) as f32
    }

    /// Sample height at world position using bilinear interpolation
    pub fn sample_height(&self, world_x: f32, world_z: f32) -> Option<f32> {
        let local_x = world_x - self.offset.x;
        let local_z = world_z - self.offset.z;
        let grid_x = local_x / self.scale_x;
        let grid_z = local_z / self.scale_z;

        let x0 = grid_x.floor() as i32;
        let z0 = grid_z.floor() as i32;

        if x0 < 0 || z0 < 0 || x0 >= (self.width - 1) as i32 || z0 >= (self.height - 1) as i32 {
            return None;
        }

        let x0 = x0 as usize;
        let z0 = z0 as usize;
        let fx = grid_x - x0 as f32;
        let fz = grid_z - z0 as f32;

        let h00 = self.get_height(x0, z0);
        let h10 = self.get_height(x0 + 1, z0);
        let h01 = self.get_height(x0, z0 + 1);
        let h11 = self.get_height(x0 + 1, z0 + 1);

        let h0 = h00 * (1.0 - fx) + h10 * fx;
        let h1 = h01 * (1.0 - fx) + h11 * fx;
        Some(self.offset.y + h0 * (1.0 - fz) + h1 * fz)
    }

    /// Get surface normal at world position
    pub fn sample_normal(&self, world_x: f32, world_z: f32) -> Option<Vec3> {
        if !self.contains_point(world_x, world_z) {
            return None;
        }

        let epsilon = 0.1;
        let h = self.sample_height(world_x, world_z)?;
        let hx = self.sample_height(world_x + epsilon, world_z).unwrap_or(h);
        let hz = self.sample_height(world_x, world_z + epsilon).unwrap_or(h);

        let dx = Vec3::new(epsilon, hx - h, 0.0);
        let dz = Vec3::new(0.0, hz - h, epsilon);

        Some(Vec3::new(
            dx.y * dz.z - dx.z * dz.y,
            dx.z * dz.x - dx.x * dz.z,
            dx.x * dz.y - dx.y * dz.x,
        ).normalize())
    }
}

/// Player character with physics
pub struct Player {
    pub position: Vec3,
    pub velocity: Vec3,
    pub radius: f32,
    pub height: f32,
    pub is_grounded: bool,
}

impl Player {
    pub fn new(position: Vec3, radius: f32, height: f32) -> Self {
        Self {
            position,
            velocity: Vec3::zero(),
            radius,
            height,
            is_grounded: false,
        }
    }

    /// Update physics (call this every frame)
    pub fn update(&mut self, terrains: &[Heightfield], dt: f32, gravity: f32) {
        // Apply gravity
        self.velocity.y -= gravity * dt;

        // Update position
        self.position = self.position + self.velocity * dt;

        // Find highest terrain beneath player
        let mut max_terrain_height = f32::NEG_INFINITY;
        
        for terrain in terrains {
            if let Some(height) = terrain.sample_height(self.position.x, self.position.z) {
                max_terrain_height = max_terrain_height.max(height);
            }
        }

        // Terrain collision
        let player_bottom = self.position.y;

        if max_terrain_height != f32::NEG_INFINITY && player_bottom <= max_terrain_height {
            // Player is on or below ground
            self.position.y = max_terrain_height;
            self.velocity.y = 0.0;
            self.is_grounded = true;
        } else {
            self.is_grounded = false;
        }
    }

    /// Apply movement (call before update)
    pub fn apply_movement(&mut self, forward: f32, right: f32, speed: f32, terrains: &[Heightfield]) {
        if !self.is_grounded {
            return; // Only allow movement when grounded
        }

        // Find the terrain we're standing on
        let mut normal = Vec3::new(0.0, 1.0, 0.0);
        for terrain in terrains {
            if let Some(n) = terrain.sample_normal(self.position.x, self.position.z) {
                normal = n;
                break;
            }
        }
        
        // Calculate movement direction aligned to surface
        let mut move_dir = Vec3::new(right, 0.0, forward).normalize();
        
        // Project movement onto surface plane
        let proj = move_dir.dot(&normal);
        move_dir = (move_dir - normal * proj).normalize();

        self.velocity.x = move_dir.x * speed;
        self.velocity.z = move_dir.z * speed;
    }

    /// Make the player jump
    pub fn jump(&mut self, jump_velocity: f32) {
        if self.is_grounded {
            self.velocity.y = jump_velocity;
            self.is_grounded = false;
        }
    }
}

/// Main physics world
pub struct PhysicsWorld {
    pub terrains: Vec<Heightfield>,
    pub player: Player,
    pub gravity: f32,
}

impl PhysicsWorld {
    /// Create an empty physics world
    pub fn new() -> Self {
        Self {
            terrains: Vec::new(),
            player: Player::new(Vec3::zero(), 0.5, 1.8),
            gravity: 9.81,
        }
    }

    /// Add a terrain to the world
    pub fn add_terrain(&mut self, terrain: Heightfield) {
        self.terrains.push(terrain);
    }

    /// Set player position
    pub fn set_player_position(&mut self, position: Vec3) {
        self.player.position = position;
        
        // Snap to terrain if available
        let mut max_height = f32::NEG_INFINITY;
        for terrain in &self.terrains {
            if let Some(h) = terrain.sample_height(position.x, position.z) {
                max_height = max_height.max(h);
            }
        }
        
        if max_height != f32::NEG_INFINITY {
            self.player.position.y = max_height;
        }
    }

    /// Update physics
    pub fn update(&mut self, dt: f32) {
        self.player.update(&self.terrains, dt, self.gravity);
    }

    /// Move player with input
    pub fn move_player(&mut self, forward: f32, right: f32, speed: f32) {
        self.player.apply_movement(forward, right, speed, &self.terrains);
    }

    /// Make player jump
    pub fn jump_player(&mut self, jump_velocity: f32) {
        self.player.jump(jump_velocity);
    }
}

impl Default for PhysicsWorld {
    fn default() -> Self {
        Self::new()
    }
}

// Example usage
// fn main() {
//     // Create an empty world
//     let mut world = PhysicsWorld::new();

//     println!("Mini Physics Engine Running!");
//     println!("Starting with 0 terrains\n");

//     // Create first terrain - a sine wave
//     let width = 50;
//     let height = 50;
//     let mut heights1 = Vec::new();
    
//     for z in 0..height {
//         for x in 0..width {
//             let h = (x as f32 * 0.3).sin() * 2.0 + (z as f32 * 0.2).cos() * 1.5;
//             heights1.push(h);
//         }
//     }

//     let terrain1 = Heightfield::from_heights(width, height, heights1, 1.0, 1.0)
//         .with_offset(Vec3::new(0.0, 0.0, 0.0));
    
//     world.add_terrain(terrain1);
//     println!("Added terrain 1 at offset (0, 0, 0)");

//     // Create second terrain - a ramp
//     let mut heights2 = Vec::new();
//     for z in 0..30 {
//         for x in 0..30 {
//             let h = x as f32 * 0.2; // Simple slope
//             heights2.push(h);
//         }
//     }

//     let terrain2 = Heightfield::from_heights(30, 30, heights2, 1.0, 1.0)
//         .with_offset(Vec3::new(60.0, 0.0, 0.0));
    
//     world.add_terrain(terrain2);
//     println!("Added terrain 2 at offset (60, 0, 0)");

//     // Set player starting position
//     world.set_player_position(Vec3::new(10.0, 10.0, 10.0));
//     println!("\nPlayer starting at: {:?}\n", world.player.position);

//     // Simulate 60 FPS for 3 seconds
//     let dt = 1.0 / 60.0;
//     for frame in 0..180 {
//         // Apply movement input (forward)
//         if frame < 120 {
//             world.move_player(1.0, 0.0, 5.0);
//         }

//         // Jump at frame 30
//         if frame == 30 {
//             world.jump_player(5.0);
//         }

//         world.update(dt);

//         // Print status every 30 frames
//         if frame % 30 == 0 {
//             println!(
//                 "Frame {}: pos=({:.2}, {:.2}, {:.2}), vel=({:.2}, {:.2}, {:.2}), grounded={}",
//                 frame,
//                 world.player.position.x,
//                 world.player.position.y,
//                 world.player.position.z,
//                 world.player.velocity.x,
//                 world.player.velocity.y,
//                 world.player.velocity.z,
//                 world.player.is_grounded
//             );
//         }
//     }

//     println!("\nTotal terrains in world: {}", world.terrains.len());
// }