use crate::core::editor::{Editor, Point, WindowSize};
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::renderer_text::text_due::{TextRenderer, TextRendererConfig};
use uuid::Uuid;
use std::sync::Arc;

pub fn toggle_inventory_menu(editor: &mut Editor, device: &wgpu::Device, queue: &wgpu::Queue) {
    editor.is_inventory_open = !editor.is_inventory_open;

    if editor.is_inventory_open {
        open_inventory(editor, device, queue);
    } else {
        close_inventory(editor);
    }
}

fn open_inventory(editor: &mut Editor, device: &wgpu::Device, queue: &wgpu::Queue) {
    let camera = editor.camera.as_ref().expect("Couldn't get camera");

    let window_size = WindowSize {
        width: camera.viewport.width as u32,
        height: camera.viewport.height as u32,
    };
    
    // We need camera binding group layouts etc.
    let ui_model_bind_group_layout = match &editor.ui_model_bind_group_layout {
        Some(layout) => layout,
        None => return,
    };
    let group_bind_group_layout = match &editor.group_bind_group_layout {
        Some(layout) => layout,
        None => return,
    };
    let camera = match &editor.camera {
        Some(cam) => cam,
        None => return,
    };
    
    // Background Panel
    let bg_width = 800.0;
    let bg_height = 600.0;
    let bg_pos = Point { 
        x: (window_size.width as f32 - bg_width) / 2.0, 
        y: (window_size.height as f32 - bg_height) / 2.0 
    };
    // because it is positioned according to its center, not top-left
    let bg_pos = Point { 
        x: bg_pos.x + (bg_width / 2.0), 
        y: bg_pos.y + (bg_height / 2.0) 
    };
    
    let bg_id = Uuid::new_v4();
    editor.inventory_ui_ids.push(bg_id);

    println!("Open inventory {:?}", bg_pos);
    
    let background = Polygon::new(
        &window_size,
        device,
        queue,
        ui_model_bind_group_layout,
        group_bind_group_layout,
        camera,
        vec![Point{x:0.0, y:0.0}, Point{x:1.0, y:0.0}, Point{x:1.0, y:1.0}, Point{x:0.0, y:1.0}],
        (bg_width, bg_height),
        bg_pos,
        (0.0, 0.0, 0.0),
        0.0,
        [0.1, 0.1, 0.1, 0.9], // Dark background
        Stroke { thickness: 2.0, fill: [0.8, 0.8, 0.8, 1.0] },
        200, // Layer
        "Inventory Background".to_string(),
        bg_id,
        Uuid::nil(),
    );
    
    editor.ui_polygons.push(background);

    // Title
    let title_id = Uuid::new_v4();
    editor.inventory_ui_ids.push(title_id);
    
    // Use "Basic" font or fallback
    let font_bytes = editor.font_manager.get_font_by_name("Basic")
        .unwrap_or_else(|| &editor.font_manager.font_data[0].1);

    let title_config = TextRendererConfig {
        id: title_id,
        name: "Inventory Title".to_string(),
        text: "INVENTORY".to_string(),
        font_family: "Basic".to_string(),
        font_size: 48,
        dimensions: (200.0, 50.0),
        position: Point { x: bg_pos.x + 20.0, y: bg_pos.y + 20.0 },
        layer: 201,
        color: [255, 255, 255, 255],
        background_fill: [0, 0, 0, 0],
    };
    
    let title_text = TextRenderer::new(
        device,
        queue,
        ui_model_bind_group_layout,
        group_bind_group_layout,
        font_bytes,
        &window_size,
        "INVENTORY".to_string(),
        title_config,
        title_id,
        Uuid::nil(),
        camera
    );
    editor.ui_textboxes.push(title_text);
    
    // Items
    if let Some(state) = &editor.renderer_state {
        if let Some(player) = &state.player_character {
             for (i, item_id) in player.inventory.items.iter().enumerate() {
                let item_ui_id = Uuid::new_v4();
                editor.inventory_ui_ids.push(item_ui_id);
                
                let item_text_config = TextRendererConfig {
                    id: item_ui_id,
                    name: format!("Item {}", i),
                    text: item_id.clone(), // Display ID for now
                    font_family: "Basic".to_string(),
                    font_size: 24,
                    dimensions: (300.0, 30.0),
                    position: Point { x: bg_pos.x + 30.0, y: bg_pos.y + 80.0 + (i as f32 * 40.0) },
                    layer: 201,
                    color: [200, 200, 200, 255],
                    background_fill: [0, 0, 0, 0],
                };
                
                let item_text = TextRenderer::new(
                    device,
                    queue,
                    ui_model_bind_group_layout,
                    group_bind_group_layout,
                    font_bytes,
                    &window_size,
                    item_id.clone(),
                    item_text_config,
                    item_ui_id,
                    Uuid::nil(),
                    camera
                );
                editor.ui_textboxes.push(item_text);
             }
        }
    }
}

fn close_inventory(editor: &mut Editor) {
    let ids = &editor.inventory_ui_ids;
    editor.ui_polygons.retain(|p| !ids.contains(&p.id));
    editor.ui_textboxes.retain(|t| !ids.contains(&t.id));
    editor.inventory_ui_ids.clear();
}
