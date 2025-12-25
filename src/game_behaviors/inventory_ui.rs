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
    let poly_bg_pos = Point { 
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
        poly_bg_pos,
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
        dimensions: (300.0, 50.0),
        position: Point { x: bg_pos.x + 120.0, y: bg_pos.y + 20.0 },
        layer: 201,
        color: [255, 255, 255, 255],
        background_fill: [0, 0, 0, 0],
    };
    
    let mut title_text = TextRenderer::new(
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

    title_text.render_text(device, queue);

    editor.ui_textboxes.push(title_text);
    
    // Items
    if let Some(state) = &editor.renderer_state {
        if let Some(player) = &state.player_character {
             for (i, item) in player.inventory.items.iter().enumerate() {
                let item_id = item.id.clone();
                let item_ui_id = Uuid::new_v4();
                editor.inventory_ui_ids.push(item_ui_id);
                
                let item_text_config = TextRendererConfig {
                    id: item_ui_id,
                    name: format!("Item {}", i),
                    text: item_id.clone(), // Display ID for now
                    font_family: "Basic".to_string(),
                    font_size: 24,
                    dimensions: (300.0, 30.0),
                    position: Point { x: bg_pos.x + 130.0, y: bg_pos.y + 80.0 + (i as f32 * 40.0) },
                    layer: 201,
                    color: [200, 200, 200, 255],
                    background_fill: [0, 0, 0, 0],
                };
                
                let mut item_text = TextRenderer::new(
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

                

                item_text.render_text(device, queue);

                editor.ui_textboxes.push(item_text);
             }

             // Equipped Items Display
             let equipped_section_x = bg_pos.x + 150.0;
             let equipped_section_y = bg_pos.y + 80.0;
             
             // Weapon Label
             let weapon_label_id = Uuid::new_v4();
             editor.inventory_ui_ids.push(weapon_label_id);
             let weapon_label_config = TextRendererConfig {
                id: weapon_label_id,
                name: "Equipped Weapon Label".to_string(),
                text: "Equipped Weapon:".to_string(),
                font_family: "Basic".to_string(),
                font_size: 24,
                dimensions: (450.0, 30.0),
                position: Point { x: equipped_section_x, y: equipped_section_y },
                layer: 201,
                color: [255, 200, 100, 255], // Gold-ish color for label
                background_fill: [0, 0, 0, 0],
             };
             let mut weapon_label = TextRenderer::new(
                device, queue, ui_model_bind_group_layout, group_bind_group_layout,
                font_bytes, &window_size, "Equipped Weapon:".to_string(),
                weapon_label_config, weapon_label_id, Uuid::nil(), camera
             );
             weapon_label.render_text(device, queue);
             editor.ui_textboxes.push(weapon_label);

             // Weapon Value
             let weapon_text = if let Some(weapon) = player.inventory.equipped_weapon.clone() {
                weapon.generic_properties.name
             } else {
                "None".to_string()
             };

             let weapon_val_id = Uuid::new_v4();
             editor.inventory_ui_ids.push(weapon_val_id);
             let weapon_val_config = TextRendererConfig {
                id: weapon_val_id,
                name: "Equipped Weapon Value".to_string(),
                text: weapon_text.clone(),
                font_family: "Basic".to_string(),
                font_size: 24,
                dimensions: (450.0, 30.0),
                position: Point { x: equipped_section_x, y: equipped_section_y + 30.0 },
                layer: 201,
                color: [255, 255, 255, 255],
                background_fill: [0, 0, 0, 0],
             };
             let mut weapon_val = TextRenderer::new(
                device, queue, ui_model_bind_group_layout, group_bind_group_layout,
                font_bytes, &window_size, weapon_text,
                weapon_val_config, weapon_val_id, Uuid::nil(), camera
             );
             weapon_val.render_text(device, queue);
             editor.ui_textboxes.push(weapon_val);

             // Armor Label
             let armor_label_id = Uuid::new_v4();
             editor.inventory_ui_ids.push(armor_label_id);
             let armor_label_config = TextRendererConfig {
                id: armor_label_id,
                name: "Equipped Armor Label".to_string(),
                text: "Equipped Armor:".to_string(),
                font_family: "Basic".to_string(),
                font_size: 24,
                dimensions: (450.0, 30.0),
                position: Point { x: equipped_section_x, y: equipped_section_y + 80.0 },
                layer: 201,
                color: [255, 200, 100, 255],
                background_fill: [0, 0, 0, 0],
             };
             let mut armor_label = TextRenderer::new(
                device, queue, ui_model_bind_group_layout, group_bind_group_layout,
                font_bytes, &window_size, "Equipped Armor:".to_string(),
                armor_label_config, armor_label_id, Uuid::nil(), camera
             );
             armor_label.render_text(device, queue);
             editor.ui_textboxes.push(armor_label);

             // Armor Value
             let armor_text = if let Some(armor) = player.inventory.equipped_armor.clone() {
                armor.generic_properties.name
             } else {
                "None".to_string()
             };

             let armor_val_id = Uuid::new_v4();
             editor.inventory_ui_ids.push(armor_val_id);
             let armor_val_config = TextRendererConfig {
                id: armor_val_id,
                name: "Equipped Armor Value".to_string(),
                text: armor_text.clone(),
                font_family: "Basic".to_string(),
                font_size: 24,
                dimensions: (450.0, 30.0),
                position: Point { x: equipped_section_x, y: equipped_section_y + 110.0 },
                layer: 201,
                color: [255, 255, 255, 255],
                background_fill: [0, 0, 0, 0],
             };
             let mut armor_val = TextRenderer::new(
                device, queue, ui_model_bind_group_layout, group_bind_group_layout,
                font_bytes, &window_size, armor_text,
                armor_val_config, armor_val_id, Uuid::nil(), camera
             );
             armor_val.render_text(device, queue);
             editor.ui_textboxes.push(armor_val);
        }
    }
}

fn close_inventory(editor: &mut Editor) {
    let ids = &editor.inventory_ui_ids;
    editor.ui_polygons.retain(|p| !ids.contains(&p.id));
    editor.ui_textboxes.retain(|t| !ids.contains(&t.id));
    editor.inventory_ui_ids.clear();
}
