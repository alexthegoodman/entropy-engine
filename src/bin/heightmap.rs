use entropy_engine::procedural_heightmaps::heightmap_generation::{FalloffType, FeatureType, HeightmapGenerator, TerrainFeature};

fn main() {
    // Example usage
    let mut generator = HeightmapGenerator::new(1024, 1024)
        .with_scale(1024.0) // for now, just set to size, till fixed
        .with_octaves(8)
        .with_persistence(0.5)
        .with_seed(42);

    // Add a large mountain
    generator.add_feature(TerrainFeature::new(
        (0.5, 0.5),           // Center of map
        0.3,                   // Large radius
        0.8,                   // Strong intensity
        FalloffType::Smooth,
        FeatureType::Mountain,
    ));

    // Add a valley
    generator.add_feature(TerrainFeature::new(
        (0.25, 0.75),
        0.15,
        0.5,
        FalloffType::Gaussian,
        FeatureType::Valley,
    ));

    // Add a plateau
    generator.add_feature(TerrainFeature::new(
        (0.75, 0.25),
        0.2,
        0.6,
        FalloffType::Linear,
        FeatureType::Plateau,
    ));

    // Add a ridge
    generator.add_feature(TerrainFeature::new(
        (0.5, 0.8),
        0.1,
        0.4,
        FalloffType::Smooth,
        FeatureType::Ridge,
    ));

    println!("Generating 1024x1024 heightmap...");
    match generator.save("heightmap.png") {
        Ok(_) => println!("Heightmap saved to heightmap.png"),
        Err(e) => eprintln!("Error saving heightmap: {}", e),
    }
}