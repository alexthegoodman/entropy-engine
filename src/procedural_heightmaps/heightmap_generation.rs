use image::{ImageBuffer, Luma};
use noise::{NoiseFn, Perlin, Fbm};
use std::f64::consts::PI;
use noise::MultiFractal;

#[derive(Clone, Copy)]
pub enum FeatureType {
    Mountain,
    Valley,
    Plateau,
    Ridge,
}

#[derive(Clone, Copy)]
pub enum FalloffType {
    Linear,
    Smooth,      // Smoothstep
    Gaussian,
}

#[derive(Clone)]
pub struct TerrainFeature {
    pub center: (f64, f64),        // 0.0-1.0 normalized coordinates
    pub radius: f64,               // Radius of influence (0.0-1.0)
    pub intensity: f64,            // Height multiplier
    pub falloff: FalloffType,
    pub feature_type: FeatureType,
    pub flat_top_ratio: f64,       // 0.0-1.0, portion of radius that's completely flat
    pub transition_ratio: f64,     // NEW: 0.0-1.0, additional ratio for smooth transition
}

impl TerrainFeature {
    pub fn new(center: (f64, f64), radius: f64, intensity: f64, 
               falloff: FalloffType, feature_type: FeatureType) -> Self {
        Self { 
            center, 
            radius, 
            intensity, 
            falloff, 
            feature_type,
            flat_top_ratio: 0.0,
            transition_ratio: 0.0,
        }
    }

    /// Set the flat top ratio (0.0 = no flat area, 1.0 = entirely flat)
    /// The flat area will have no noise applied to it
    pub fn with_flat_top(mut self, ratio: f64) -> Self {
        self.flat_top_ratio = ratio.clamp(0.0, 1.0);
        self
    }

    /// Set the transition ratio (additional zone where noise gradually blends in)
    /// For example, flat_top=0.5 and transition=0.2 means:
    /// - 0.0 to 0.5: completely flat (no noise)
    /// - 0.5 to 0.7: gradual blend from no noise to full noise
    /// - 0.7 to 1.0: full noise applied
    pub fn with_transition(mut self, ratio: f64) -> Self {
        self.transition_ratio = ratio.clamp(0.0, 1.0);
        self
    }
}

pub struct HeightmapGenerator {
    width: u32,
    height: u32,
    scale: f64,           // Noise scale
    octaves: usize,       // Detail level
    persistence: f64,     // How much each octave contributes
    lacunarity: f64,      // Frequency multiplier per octave
    seed: u32,
    features: Vec<TerrainFeature>,
}

impl HeightmapGenerator {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            scale: 100.0,
            octaves: 6,
            persistence: 0.5,
            lacunarity: 2.0,
            seed: 0,
            features: Vec::new(),
        }
    }

    pub fn with_scale(mut self, scale: f64) -> Self {
        self.scale = scale;
        self
    }

    pub fn with_octaves(mut self, octaves: usize) -> Self {
        self.octaves = octaves;
        self
    }

    pub fn with_persistence(mut self, persistence: f64) -> Self {
        self.persistence = persistence;
        self
    }

    pub fn with_lacunarity(mut self, lacunarity: f64) -> Self {
        self.lacunarity = lacunarity;
        self
    }

    pub fn with_seed(mut self, seed: u32) -> Self {
        self.seed = seed;
        self
    }

    pub fn add_feature(&mut self, feature: TerrainFeature) {
        self.features.push(feature);
    }

    fn calculate_falloff(&self, distance: f64, radius: f64, falloff_type: FalloffType) -> f64 {
        if distance >= radius {
            return 0.0;
        }

        let normalized = distance / radius;

        match falloff_type {
            FalloffType::Linear => 1.0 - normalized,
            FalloffType::Smooth => {
                let t = 1.0 - normalized;
                t * t * (3.0 - 2.0 * t) // Smoothstep
            }
            FalloffType::Gaussian => {
                (-4.0 * normalized * normalized).exp()
            }
        }
    }

    fn calculate_feature_height(&self, x: f64, y: f64, feature: &TerrainFeature) -> f64 {
        let dx = x - feature.center.0;
        let dy = y - feature.center.1;
        let distance = (dx * dx + dy * dy).sqrt();

        let falloff = self.calculate_falloff(distance, feature.radius, feature.falloff);

        match feature.feature_type {
            FeatureType::Mountain => {
                falloff * feature.intensity
            }
            FeatureType::Valley => {
                -falloff * feature.intensity
            }
            FeatureType::Plateau => {
                // Plateau has a flat top
                if distance < feature.radius * 0.5 {
                    feature.intensity
                } else {
                    falloff * feature.intensity
                }
            }
            FeatureType::Ridge => {
                // Ridge along one axis
                let ridge_distance = dx.abs();
                let ridge_falloff = self.calculate_falloff(
                    ridge_distance, 
                    feature.radius, 
                    feature.falloff
                );
                ridge_falloff * feature.intensity
            }
        }
    }

    /// Calculate the noise blend factor for a given point (0.0 = no noise, 1.0 = full noise)
    fn calculate_noise_blend(&self, x: f64, y: f64) -> f64 {
        let mut min_blend: f64 = 1.0; // Start with full noise
        
        for feature in &self.features {
            if feature.flat_top_ratio > 0.0 {
                let dx = x - feature.center.0;
                let dy = y - feature.center.1;
                
                let distance = match feature.feature_type {
                    FeatureType::Ridge => dx.abs(),  // Ridge uses x-distance
                    _ => (dx * dx + dy * dy).sqrt(), // Others use radial distance
                };
                
                let flat_radius = feature.radius * feature.flat_top_ratio;
                let transition_end = feature.radius * (feature.flat_top_ratio + feature.transition_ratio).min(1.0);
                
                let blend = if distance < flat_radius {
                    // Inside flat region: no noise
                    0.0
                } else if distance < transition_end {
                    // In transition zone: gradual blend using smoothstep
                    let transition_distance = distance - flat_radius;
                    let transition_width = transition_end - flat_radius;
                    
                    if transition_width > 0.0 {
                        let t = (transition_distance / transition_width).clamp(0.0, 1.0);
                        // Smoothstep for smooth transition
                        t * t * (3.0 - 2.0 * t)
                    } else {
                        1.0
                    }
                } else {
                    // Outside transition: full noise
                    1.0
                };
                
                // Use the minimum blend factor (most restrictive)
                min_blend = min_blend.min(blend);
            }
        }
        
        min_blend
    }

    pub fn generate(&self) -> ImageBuffer<Luma<u16>, Vec<u16>> {
        let mut img = ImageBuffer::new(self.width, self.height);
        
        // Setup noise generator
        let fbm = Fbm::<Perlin>::new(self.seed)
            .set_frequency(0.005)
            .set_octaves(self.octaves)
            .set_persistence(self.persistence)
            .set_lacunarity(self.lacunarity);

        // First pass: collect all heights to find min/max
        let mut heights = vec![0.0; (self.width * self.height) as usize];
        let mut min_height = f64::INFINITY;
        let mut max_height = f64::NEG_INFINITY;

        for y in 0..self.height {
            for x in 0..self.width {
                let nx = x as f64 / self.width as f64;
                let ny = y as f64 / self.height as f64;

                // Calculate noise blend factor (0.0 = no noise, 1.0 = full noise)
                let noise_blend = self.calculate_noise_blend(nx, ny);

                // Base noise with blend factor applied
                let noise_x = nx * self.scale;
                let noise_y = ny * self.scale;
                let base_noise = fbm.get([noise_x, noise_y]);
                let mut height = base_noise * noise_blend;

                // Add features
                for feature in &self.features {
                    height += self.calculate_feature_height(nx, ny, feature);
                }

                let idx = (y * self.width + x) as usize;
                heights[idx] = height;

                min_height = min_height.min(height);
                max_height = max_height.max(height);
            }
        }

        // Second pass: normalize and write to image
        let range = max_height - min_height;
        for y in 0..self.height {
            for x in 0..self.width {
                let idx = (y * self.width + x) as usize;
                let height = heights[idx];

                // Normalize to 0.0-1.0
                let normalized = if range > 0.0 {
                    (height - min_height) / range
                } else {
                    0.5
                };

                // Map to u16 range
                let pixel_value = (normalized * 65535.0).clamp(0.0, 65535.0) as u16;
                img.put_pixel(x, y, Luma([pixel_value]));
            }
        }

        img
    }

    pub fn save(&self, path: &str) -> Result<(), image::ImageError> {
        let img = self.generate();
        img.save(path)
    }
}