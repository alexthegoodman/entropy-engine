use nalgebra::{vector, ComplexField, Vector3};
use nalgebra_glm::Vec3;
use rand::Rng;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::core::Transform_2::Transform;
use crate::core::PlayerCharacter::Stats;

use super::chase::ChaseBehavior;

// Basic attack configuration
#[derive(Clone)]
pub struct AttackStats {
    pub damage: f32,
    pub range: f32,
    pub cooldown: f32,
    pub wind_up_time: f32,
    pub recovery_time: f32,
}

// Reusable attack state tracking
#[derive(PartialEq)]
enum AttackState {
    Ready,
    WindingUp(Instant),
    Attacking(Instant),
    Recovering(Instant),
}

pub struct MeleeAttackBehavior {
    pub stats: AttackStats,
    state: AttackState,
    last_attack: Instant,
}

impl MeleeAttackBehavior {
    pub fn new(stats: AttackStats) -> Self {
        Self {
            stats,
            state: AttackState::Ready,
            last_attack: Instant::now(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        attacker_handle: RigidBodyHandle,
        target_handle: RigidBodyHandle,
        transform: &Transform,
    ) -> Option<f32> {
        // Returns damage dealt if attack lands
        let current_pos = transform.position;

        // Get target position
        let target_pos = if let Some(target_body) = rigid_body_set.get(target_handle) {
            Vec3::new(
                target_body.translation().x,
                target_body.translation().y,
                target_body.translation().z,
            )
        } else {
            return None;
        };

        // Check if target is in range
        let distance = current_pos.metric_distance(&target_pos);
        if distance > self.stats.range {
            return None;
        }

        match self.state {
            AttackState::Ready => {
                if self.last_attack.elapsed().as_secs_f32() >= self.stats.cooldown {
                    self.state = AttackState::WindingUp(Instant::now());
                }
                None
            }
            AttackState::WindingUp(start_time) => {
                if start_time.elapsed().as_secs_f32() >= self.stats.wind_up_time {
                    self.state = AttackState::Attacking(Instant::now());
                }
                None
            }
            AttackState::Attacking(start_time) => {
                if start_time.elapsed().as_secs_f32() >= 0.1 {
                    // Attack frame
                    self.state = AttackState::Recovering(Instant::now());
                    self.last_attack = Instant::now();
                    Some(self.stats.damage)
                } else {
                    None
                }
            }
            AttackState::Recovering(start_time) => {
                if start_time.elapsed().as_secs_f32() >= self.stats.recovery_time {
                    self.state = AttackState::Ready;
                }
                None
            }
        }
    }
}

pub struct EvadeBehavior {
    pub speed: f32,
    pub evade_distance: f32,
    pub cooldown: f32,
    last_evade: Instant,
    // rng: rand::rngs::ThreadRng,
}

impl EvadeBehavior {
    pub fn new(speed: f32, evade_distance: f32) -> Self {
        Self {
            speed,
            evade_distance,
            cooldown: 1.0,
            last_evade: Instant::now(),
            // rng: rand::thread_rng(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        evader_handle: RigidBodyHandle,
        threat_handle: RigidBodyHandle,
        transform: &Transform,
        dt: f32,
    ) -> bool {
        // Returns true if currently evading
        if self.last_evade.elapsed().as_secs_f32() < self.cooldown {
            return false;
        }

        let mut rng = rand::thread_rng();

        let current_pos = transform.position;

        // Get threat position
        let threat_pos = if let Some(threat_body) = rigid_body_set.get(threat_handle) {
            Vec3::new(
                threat_body.translation().x,
                threat_body.translation().y,
                threat_body.translation().z,
            )
        } else {
            return false;
        };

        // Calculate evade direction (perpendicular to threat direction)
        let to_threat = threat_pos - current_pos;
        let angle = rng.gen_bool(0.5); // Randomly choose left or right
        let evade_direction = if angle {
            Vec3::new(-to_threat.z, 0.0, to_threat.x).normalize()
        } else {
            Vec3::new(to_threat.z, 0.0, -to_threat.x).normalize()
        };

        // Check if evade path is clear
        let ball = ColliderBuilder::ball(0.5).build();
        let shape = ball.shape().clone();
        let shape_pos = Isometry::new(
            vector![current_pos.x, current_pos.y, current_pos.z],
            vector![0.0, 0.0, 0.0],
        );
        let shape_vel = vector![
            evade_direction.x * self.evade_distance,
            0.0,
            evade_direction.z * self.evade_distance
        ];

        let obstacle_detected = query_pipeline
            .cast_shape(
                &rigid_body_set,
                &collider_set,
                &shape_pos,
                &shape_vel,
                shape,
                ShapeCastOptions::default(),
                QueryFilter::default().exclude_rigid_body(evader_handle),
            )
            .is_some();

        if !obstacle_detected {
            // Apply evade movement
            if let Some(rigid_body) = rigid_body_set.get_mut(evader_handle) {
                let movement = evade_direction * self.speed * dt;
                let mut linvel = rigid_body.linvel().clone();
                linvel.x = movement.x;
                linvel.z = movement.z;
                rigid_body.set_linvel(linvel, true);
                self.last_evade = Instant::now();
                return true;
            }
        }

        false
    }
}

pub struct DefenseBehavior {
    pub block_chance: f32,
    pub block_cooldown: f32,
    pub stamina_cost: f32,
    last_block: Instant,
}

impl DefenseBehavior {
    pub fn new(block_chance: f32) -> Self {
        Self {
            block_chance,
            block_cooldown: 0.5,
            stamina_cost: 10.0,
            last_block: Instant::now(),
        }
    }

    pub fn try_block(&mut self, incoming_damage: f32, current_stamina: f32) -> (f32, f32) {
        // Returns (damage_taken, stamina_used)
        if self.last_block.elapsed().as_secs_f32() < self.block_cooldown
            || current_stamina < self.stamina_cost
        {
            return (incoming_damage, 0.0);
        }

        let mut rng = rand::thread_rng();
        if rng.r#gen::<f32>() <= self.block_chance {
            self.last_block = Instant::now();
            (0.0, self.stamina_cost) // Successful block
        } else {
            (incoming_damage, 0.0) // Failed block
        }
    }
}

// High-level behavior that combines the others
pub struct MeleeCombatBehavior {
    pub chase: ChaseBehavior, // Reuse your existing ChaseBehavior
    pub attack: MeleeAttackBehavior,
    pub evade: EvadeBehavior,
    pub defense: DefenseBehavior,
    state_machine: CombatState,
    last_state_change: Instant,
}

#[derive(PartialEq)]
enum CombatState {
    Chasing,
    Attacking,
    Evading,
    Defending,
}

impl MeleeCombatBehavior {
    pub fn new(
        chase_speed: f32,
        detection_radius: f32,
        attack_stats: AttackStats,
        evade_speed: f32,
        block_chance: f32,
    ) -> Self {
        Self {
            chase: ChaseBehavior::new(chase_speed, detection_radius),
            attack: MeleeAttackBehavior::new(attack_stats),
            evade: EvadeBehavior::new(evade_speed, 3.0),
            defense: DefenseBehavior::new(block_chance),
            state_machine: CombatState::Chasing,
            last_state_change: Instant::now(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        entity_handle: RigidBodyHandle,
        target_handle: RigidBodyHandle,
        collider: &Collider,
        transform: &mut Transform,
        current_stamina: f32,
        dt: f32,
    ) -> Option<f32> {
        // Returns damage dealt if attack lands
        let min_state_duration = 8.0; // Minimum time to stay in a state
        let state_duration = self.last_state_change.elapsed().as_secs_f32();

        // State machine logic
        match self.state_machine {
            CombatState::Chasing => {
                // println!("Chasing");
                self.chase.update(
                    rigid_body_set,
                    collider_set,
                    query_pipeline,
                    entity_handle,
                    target_handle,
                    collider,
                    transform,
                    dt,
                );

                // Transition to attacking if in range
                if state_duration >= min_state_duration {
                    let target_pos = rigid_body_set.get(target_handle)?.translation();
                    let distance = transform.position.metric_distance(&Vec3::new(
                        target_pos.x,
                        target_pos.y,
                        target_pos.z,
                    ));

                    if distance <= self.attack.stats.range {
                        self.state_machine = CombatState::Attacking;
                        self.last_state_change = Instant::now();
                    }
                }
                None
            }
            CombatState::Attacking => {
                // println!("Attacking");
                let damage = self.attack.update(
                    rigid_body_set,
                    collider_set,
                    query_pipeline,
                    entity_handle,
                    target_handle,
                    transform,
                );

                // Transition to evading after attack or if too close
                if state_duration >= min_state_duration {
                    let target_pos = rigid_body_set.get(target_handle)?.translation();
                    let distance = transform.position.metric_distance(&Vec3::new(
                        target_pos.x,
                        target_pos.y,
                        target_pos.z,
                    ));

                    // if distance < self.attack.stats.range * 0.5 {
                    self.state_machine = CombatState::Evading;
                    self.last_state_change = Instant::now();
                    // }
                }
                damage
            }
            CombatState::Evading => {
                // println!("Evading");
                let is_evading = self.evade.update(
                    rigid_body_set,
                    collider_set,
                    query_pipeline,
                    entity_handle,
                    target_handle,
                    transform,
                    dt,
                );

                // Transition back to chasing if evade complete
                if state_duration >= min_state_duration && !is_evading {
                    self.state_machine = CombatState::Chasing;
                    self.last_state_change = Instant::now();
                }
                None
            }
            CombatState::Defending => {
                // println!("Defending");
                // Transition back to chasing after defense
                if state_duration >= min_state_duration {
                    self.state_machine = CombatState::Chasing;
                    self.last_state_change = Instant::now();
                }
                None
            }
        }
    }

    // Called when receiving damage
    pub fn handle_incoming_damage(&mut self, damage: f32, stats: &mut Stats) {
        self.state_machine = CombatState::Defending;
        self.last_state_change = Instant::now();
        let (damage_taken, stamina_used) = self.defense.try_block(damage, stats.stamina);

        stats.health -= damage_taken;
        stats.stamina -= stamina_used;

        if stats.health < 0.0 {
            stats.health = 0.0;
        }
        if stats.stamina < 0.0 {
            stats.stamina = 0.0;
        }

        println!(
            "NPC Health: {:.2}, Stamina: {:.2}",
            stats.health, stats.stamina
        );
    }

    pub fn get_animation_name(&self) -> &str {
        match self.state_machine {
            CombatState::Chasing => "Walking", // Or "Running"
            CombatState::Attacking => "Attack",
            CombatState::Evading => "Evade", // Or some dodge/roll animation
            CombatState::Defending => "Defend", // Or "Block"
        }
    }
}
