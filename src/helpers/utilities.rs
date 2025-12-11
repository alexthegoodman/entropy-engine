use std::{fs, path::PathBuf};

use directories::{BaseDirs, UserDirs};
use nalgebra::Matrix4;
use uuid::Uuid;

use super::saved_data::{LevelData, SavedState};

pub fn get_common_os_dir() -> Option<PathBuf> {
    UserDirs::new().map(|user_dirs| {
        let common_os = user_dirs
            .document_dir()
            .expect("Couldn't find Documents directory")
            .join("CommonOS");
        fs::create_dir_all(&common_os)
            .ok()
            .expect("Couldn't check or create CommonOS directory");
        common_os
    })
}

pub fn get_projects_dir() -> Option<PathBuf> {
    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let projects_dir = sync_dir.join("midpoint/projects");

    fs::create_dir_all(&projects_dir)
        .ok()
        .expect("Couldn't check or create Projects directory");

    Some(projects_dir)
}

pub fn get_project_dir(project_id: &str) -> Option<PathBuf> {
    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let project_dir = sync_dir.join("midpoint/projects").join(project_id);

    fs::create_dir_all(&project_dir)
        .ok()
        .expect("Couldn't check or create Projects directory");

    Some(project_dir)
}

pub fn get_heightmap_dir(project_id: &str, landscape_id: &str) -> Option<PathBuf> {
    let project_dir = get_project_dir(project_id).expect("Couldn't get project directory");
    let landscape_dir = project_dir.join("landscapes").join(landscape_id);
    let heightmap_dir = landscape_dir.join("heightmaps");

    fs::create_dir_all(&heightmap_dir)
        .ok()
        .expect("Couldn't check or create Heightmaps directory");

    Some(heightmap_dir)
}

pub fn get_soilmap_dir(project_id: &str, landscape_id: &str) -> Option<PathBuf> {
    let project_dir = get_project_dir(project_id).expect("Couldn't get project directory");
    let landscape_dir = project_dir.join("landscapes").join(landscape_id);
    let heightmap_dir = landscape_dir.join("soils");

    fs::create_dir_all(&heightmap_dir)
        .ok()
        .expect("Couldn't check or create Soils directory");

    Some(heightmap_dir)
}

pub fn get_rockmap_dir(project_id: &str, landscape_id: &str) -> Option<PathBuf> {
    let project_dir = get_project_dir(project_id).expect("Couldn't get project directory");
    let landscape_dir = project_dir.join("landscapes").join(landscape_id);
    let heightmap_dir = landscape_dir.join("rockmaps");

    fs::create_dir_all(&heightmap_dir)
        .ok()
        .expect("Couldn't check or create Rockmaps directory");

    Some(heightmap_dir)
}

pub fn get_textures_dir(project_id: &str) -> Option<PathBuf> {
    let project_dir = get_project_dir(project_id).expect("Couldn't get project directory");
    let textures_dir = project_dir.join("textures");

    fs::create_dir_all(&textures_dir)
        .ok()
        .expect("Couldn't check or create Textures directory");

    Some(textures_dir)
}

pub fn get_models_dir(project_id: &str) -> Option<PathBuf> {
    let project_dir = get_project_dir(project_id).expect("Couldn't get project directory");
    let models_dir = project_dir.join("models");

    fs::create_dir_all(&models_dir)
        .ok()
        .expect("Couldn't check or create Models directory");

    Some(models_dir)
}

pub fn load_project_state(project_id: &str) -> Result<SavedState, Box<dyn std::error::Error>> {
    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let project_dir = sync_dir.join("midpoint/projects").join(project_id);
    let json_path = project_dir.join("midpoint.json");

    // Check if the project directory and json file exist
    if !project_dir.exists() {
        return Err(format!("Project directory '{}' not found", project_id).into());
    }
    if !json_path.exists() {
        return Err(format!("midpoint.json not found in project '{}'", project_id).into());
    }

    // Read and parse the JSON file
    let json_content = fs::read_to_string(json_path)?;
    let state: SavedState = serde_json::from_str(&json_content)?;

    Ok(state)
}

pub fn update_project_state(project_id: &str, saved_state: &SavedState) -> Result<(), Box<dyn std::error::Error>> {
    let project_dir = get_project_dir(project_id).expect("Couldn't get project directory");
    let json_path = project_dir.join("midpoint.json");

    let json = serde_json::to_string_pretty(saved_state)?;
    fs::write(json_path, json)?;

    Ok(())
}

pub fn create_project_state(project_id: &str) -> Result<SavedState, Box<dyn std::error::Error>> {
    let project_dir = get_project_dir(project_id).expect("Couldn't get project directory");

    let empty_level = LevelData {
        id: Uuid::new_v4().to_string(),
        components: Some(Vec::new()),
    };

    let mut levels = Vec::new();
    levels.push(empty_level);

    let empty_saved_state = SavedState {
        concepts: Vec::new(),
        models: Vec::new(),
        landscapes: Some(Vec::new()),
        textures: Some(Vec::new()),
        pbr_textures: Some(Vec::new()),
        levels: Some(levels),
        skeleton_parts: Vec::new(),
        skeletons: Vec::new(),
        motion_paths: Vec::new(),
        id: None,
        sequences: None,
        timeline_state: None
    };

    let json = serde_json::to_string_pretty(&empty_saved_state)?;
    fs::write(project_dir.join("midpoint.json"), json)?;

    Ok(empty_saved_state)
}
