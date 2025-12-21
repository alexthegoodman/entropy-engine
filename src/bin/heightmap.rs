use entropy_engine::procedural_heightmaps::heightmap_generation::{FalloffType, FeatureType, HeightmapGenerator, TerrainFeature};

fn main() {
    let mut generator = HeightmapGenerator::new(1024, 1024)
        .with_scale(1024.0)
        .with_octaves(8)
        .with_persistence(0.5)
        .with_seed(42);

    // Mountain with flat top and smooth transition
    // 40% completely flat, 20% gradual transition to full noise
    generator.add_feature(TerrainFeature::new(
        (0.5, 0.5),
        0.3,
        0.8,
        FalloffType::Smooth,
        FeatureType::Mountain,
    ).with_flat_top(0.4)
     .with_transition(0.2));

    // Valley with flat bottom and gentle transition
    generator.add_feature(TerrainFeature::new(
        (0.25, 0.75),
        0.15,
        0.5,
        FalloffType::Gaussian,
        FeatureType::Valley,
    ).with_flat_top(0.2)
     .with_transition(0.3));

    // Plateau with wide transition zone
    generator.add_feature(TerrainFeature::new(
        (0.75, 0.25),
        0.2,
        0.6,
        FalloffType::Linear,
        FeatureType::Plateau,
    ).with_flat_top(0.5)
     .with_transition(0.25));

    // Ridge with flat center and narrow transition
    generator.add_feature(TerrainFeature::new(
        (0.5, 0.8),
        0.1,
        0.4,
        FalloffType::Smooth,
        FeatureType::Ridge,
    ).with_flat_top(0.3)
     .with_transition(0.15));

    println!("Generating 1024x1024 heightmap...");
    match generator.save("heightmap.png") {
        Ok(_) => println!("Heightmap saved to heightmap.png"),
        Err(e) => eprintln!("Error saving heightmap: {}", e),
    }
}