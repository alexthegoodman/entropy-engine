use crate::core::editor::{Editor, Point, WindowSize};
use crate::renderer_text::text_due::{TextRenderer, TextRendererConfig};
use crate::shape_primitives::polygon::{Polygon, Stroke};
use uuid::Uuid;

pub fn update_dialogue_ui(editor: &mut Editor, device: &wgpu::Device, queue: &wgpu::Queue) {
    if editor.dialogue_state.is_open {
        if editor.dialogue_state.ui_dirty || editor.dialogue_state.ui_ids.is_empty() {
             build_dialogue_ui(editor, device, queue);
             editor.dialogue_state.ui_dirty = false;
        }
    } else {
        if !editor.dialogue_state.ui_ids.is_empty() {
            close_dialogue_ui(editor);
        }
    }
}

fn close_dialogue_ui(editor: &mut Editor) {
    let ids = &editor.dialogue_state.ui_ids;
    editor.ui_polygons.retain(|p| !ids.contains(&p.id));
    editor.ui_textboxes.retain(|t| !ids.contains(&t.id));
    editor.dialogue_state.ui_ids.clear();
}

fn build_dialogue_ui(editor: &mut Editor, device: &wgpu::Device, queue: &wgpu::Queue) {
    // Clear existing first
    close_dialogue_ui(editor);

    let camera = match &editor.camera {
        Some(cam) => cam,
        None => return,
    };

    let window_size = WindowSize {
        width: camera.viewport.width as u32,
        height: camera.viewport.height as u32,
    };
    
    // Layout
    let padding = 20.0;
    let panel_height = 250.0;
    let panel_width = window_size.width as f32 - (padding * 2.0);
    
    let panel_x = padding;
    let panel_y = window_size.height as f32 - panel_height - padding;
    
    // Polygon expects center position
    let poly_pos = Point {
        x: panel_x + (panel_width / 2.0),
        y: panel_y + (panel_height / 2.0),
    };

    let bg_id = Uuid::new_v4();
    editor.dialogue_state.ui_ids.push(bg_id);
    
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
        [0.0, 0.0, 0.0, 0.8], // Black transparent
        Stroke { thickness: 2.0, fill: [1.0, 1.0, 1.0, 1.0] },
        300, // Layer (higher than inventory?)
        "Dialogue Background".to_string(),
        bg_id,
        Uuid::nil(),
    );
    editor.ui_polygons.push(background);
    
    // Text
    let font_bytes = editor.font_manager.get_font_by_name("Basic")
        .unwrap_or_else(|| &editor.font_manager.font_data[0].1);

    // NPC Name
    if !editor.dialogue_state.npc_name.is_empty() {
        let name_id = Uuid::new_v4();
        editor.dialogue_state.ui_ids.push(name_id);
        
        let name_config = TextRendererConfig {
            id: name_id,
            name: "NPC Name".to_string(),
            text: editor.dialogue_state.npc_name.clone(),
            font_family: "Basic".to_string(),
            font_size: 24,
            dimensions: (panel_width - 40.0, 30.0),
            position: Point { x: panel_x + 20.0, y: panel_y + 20.0 },
            layer: 301,
            color: [255, 200, 100, 255], // Gold
            background_fill: [0, 0, 0, 0],
        };
        
        let mut name_text = TextRenderer::new(
             device, queue, ui_model_layout, group_layout,
             font_bytes, &window_size, editor.dialogue_state.npc_name.clone(),
             name_config, name_id, Uuid::nil(), camera
        );
        name_text.render_text(device, queue);
        editor.ui_textboxes.push(name_text);
    }
    
    // Dialogue Text
    let text_id = Uuid::new_v4();
    editor.dialogue_state.ui_ids.push(text_id);
    
    let text_config = TextRendererConfig {
        id: text_id,
        name: "Dialogue Text".to_string(),
        text: editor.dialogue_state.current_text.clone(),
        font_family: "Basic".to_string(),
        font_size: 20,
        dimensions: (panel_width - 40.0, 100.0),
        position: Point { x: panel_x + 20.0, y: panel_y + 60.0 },
        layer: 301,
        color: [255, 255, 255, 255],
        background_fill: [0, 0, 0, 0],
    };
    
    let mut main_text = TextRenderer::new(
             device, queue, ui_model_layout, group_layout,
             font_bytes, &window_size, editor.dialogue_state.current_text.clone(),
             text_config, text_id, Uuid::nil(), camera
    );
    main_text.render_text(device, queue);
    editor.ui_textboxes.push(main_text);
    
    // Options
    let option_start_y = panel_y + 150.0;
    for (i, option) in editor.dialogue_state.options.iter().enumerate() {
        let opt_id = Uuid::new_v4();
        editor.dialogue_state.ui_ids.push(opt_id);
        
        let opt_config = TextRendererConfig {
            id: opt_id,
            name: format!("Option {}", i),
            text: format!("{}. {}", i+1, option.text),
            font_family: "Basic".to_string(),
            font_size: 18,
            dimensions: (panel_width - 40.0, 25.0),
            position: Point { x: panel_x + 40.0, y: option_start_y + (i as f32 * 30.0) },
            layer: 301,
            color: [200, 200, 255, 255], // Light blue
            background_fill: [0, 0, 0, 0],
        };
        
         let mut opt_text = TextRenderer::new(
             device, queue, ui_model_layout, group_layout,
             font_bytes, &window_size, format!("{}. {}", i+1, option.text),
             opt_config, opt_id, Uuid::nil(), camera
        );
        opt_text.render_text(device, queue);
        editor.ui_textboxes.push(opt_text);
    }
}
