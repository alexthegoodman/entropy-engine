use crate::core::editor::{Editor, Point, WindowSize};
use crate::renderer_text::text_due::{TextRenderer, TextRendererConfig};
use crate::shape_primitives::polygon::{Polygon, Stroke};
use uuid::Uuid;
use crate::game_ui::quest_state::QuestStatus;

pub fn update_quest_ui(editor: &mut Editor, device: &wgpu::Device, queue: &wgpu::Queue) {
    // Check if we have an active quest to display
    let mut active_quest_info = None;
    
    if let Some(renderer_state) = &editor.renderer_state {
        if let Some(quest_id) = &renderer_state.quest_state.active_quest_id {
            if let Some(quest) = renderer_state.quest_state.quests.get(quest_id) {
                if quest.status == QuestStatus::InProgress {
                     active_quest_info = Some((quest.title.clone(), quest.steps.clone()));
                }
            }
        }
    }

    if let Some((title, steps)) = active_quest_info {
        // Build or update UI
        // Ideally we only rebuild if changed. 
        // For simplicity, we clear and rebuild if we have active quest. 
        // Note: In a real engine, we'd check if the quest state changed before rebuilding.
        
        close_quest_ui(editor);
        build_quest_ui(editor, device, queue, title, steps);
        
    } else {
        if !editor.quest_ui_ids.is_empty() {
            close_quest_ui(editor);
        }
    }
}

fn close_quest_ui(editor: &mut Editor) {
    let ids = &editor.quest_ui_ids;
    editor.ui_polygons.retain(|p| !ids.contains(&p.id));
    editor.ui_textboxes.retain(|t| !ids.contains(&t.id));
    editor.quest_ui_ids.clear();
}

fn build_quest_ui(editor: &mut Editor, device: &wgpu::Device, queue: &wgpu::Queue, title: String, steps: Vec<crate::game_ui::quest_state::QuestStep>) {
    let camera = match &editor.camera {
        Some(cam) => cam,
        None => return,
    };

    let window_size = WindowSize {
        width: camera.viewport.width as u32,
        height: camera.viewport.height as u32,
    };
    
    let padding = 20.0;
    let panel_width = 300.0;
    // Calculate height based on steps
    let step_height = 25.0;
    let title_height = 30.0;
    let panel_height = title_height + (steps.len() as f32 * step_height) + 20.0;
    
    let panel_x = window_size.width as f32 - panel_width - padding;
    let panel_y = padding; // Top right
    
     // Polygon expects center position
    let poly_pos = Point {
        x: panel_x + (panel_width / 2.0),
        y: panel_y + (panel_height / 2.0),
    };

    let bg_id = Uuid::new_v4();
    editor.quest_ui_ids.push(bg_id);
    
    let ui_model_layout = match &editor.ui_model_bind_group_layout {
        Some(l) => l,
        None => return,
    };
    let group_layout = match &editor.group_bind_group_layout {
        Some(l) => l,
        None => return,
    };

    let background = Polygon::new(
        &window_size,
        device,
        queue,
        ui_model_layout,
        group_layout,
        camera,
        vec![Point{x:0.0, y:0.0}, Point{x:1.0, y:0.0}, Point{x:1.0, y:1.0}, Point{x:0.0, y:1.0}],
        (panel_width, panel_height),
        poly_pos,
        (0.0, 0.0, 0.0), // rotation
        0.0, // corner radius
        [0.0, 0.0, 0.0, 0.6], // Semi-transparent black
        Stroke { thickness: 1.0, fill: [1.0, 1.0, 1.0, 0.5] },
        300,
        "Quest Background".to_string(),
        bg_id,
        Uuid::nil(),
    );
    editor.ui_polygons.push(background);
    
    let font_bytes = editor.font_manager.get_font_by_name("Basic")
        .unwrap_or_else(|| &editor.font_manager.font_data[0].1);

    // Title
    let title_id = Uuid::new_v4();
    editor.quest_ui_ids.push(title_id);
    
    let title_config = TextRendererConfig {
        id: title_id,
        name: "Quest Title".to_string(),
        text: title.clone(),
        font_family: "Basic".to_string(),
        font_size: 20,
        dimensions: (panel_width - 20.0, title_height),
        position: Point { x: panel_x + 10.0, y: panel_y + 10.0 },
        layer: 301,
        color: [255, 215, 0, 255], // Gold
        background_fill: [0, 0, 0, 0],
    };
    
    let mut title_text = TextRenderer::new(
             device, queue, ui_model_layout, group_layout,
             font_bytes, &window_size, title,
             title_config, title_id, Uuid::nil(), camera
    );
    title_text.render_text(device, queue);
    editor.ui_textboxes.push(title_text);
    
    // Steps
    for (i, step) in steps.iter().enumerate() {
        let step_id = Uuid::new_v4();
        editor.quest_ui_ids.push(step_id);
        
        let color = if step.is_completed {
            [100, 255, 100, 255] // Green
        } else {
            [255, 255, 255, 255] // White
        };
        
        let prefix = if step.is_completed { "[x]" } else { "[ ]" };
        let text = format!("{} {}", prefix, step.description);

        let step_config = TextRendererConfig {
            id: step_id,
            name: format!("Step {}", i),
            text: text.clone(),
            font_family: "Basic".to_string(),
            font_size: 16,
            dimensions: (panel_width - 20.0, step_height),
            position: Point { x: panel_x + 20.0, y: panel_y + title_height + 10.0 + (i as f32 * step_height) },
            layer: 301,
            color,
            background_fill: [0, 0, 0, 0],
        };
        
         let mut step_text = TextRenderer::new(
             device, queue, ui_model_layout, group_layout,
             font_bytes, &window_size, text,
             step_config, step_id, Uuid::nil(), camera
        );
        step_text.render_text(device, queue);
        editor.ui_textboxes.push(step_text);
    }
}
