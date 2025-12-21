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
}

impl TerrainFeature {
    pub fn new(center: (f64, f64), radius: f64, intensity: f64, 
               falloff: FalloffType, feature_type: FeatureType) -> Self {
        Self { center, radius, intensity, falloff, feature_type }
    }
}

pub struct HeightmapGenerator {
    width: u32,
    height: u32,
    scale: f64,           // Noise scale
    octaves: usize,       // Detail level
    /// In Perlin noise, persistence is a multiplier that controls how much each successive "octave" (layer of detail) 
    /// contributes to the final result, determining the noise's roughness or smoothness; a lower value (e.g., 0.25) 
    /// makes noise smoother by reducing later octaves' impact, while a higher value (e.g., 0.75) makes it rougher 
    /// with more detailed, spikier features by letting more detail layers influence the output
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

                // Base noise
                let noise_x = nx * self.scale;
                let noise_y = ny * self.scale;
                let mut height = fbm.get([noise_x, noise_y]);

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

