use crate::core::editor::{Editor, Point, WindowSize};
use crate::renderer_text::text_due::{TextRenderer, TextRendererConfig};
use uuid::Uuid;

pub fn init_controls_ui(editor: &mut Editor, device: &wgpu::Device, queue: &wgpu::Queue) {
    let camera = match &editor.camera {
        Some(cam) => cam,
        None => return,
    };

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
    
    // Use "Basic" font or fallback
    let font_bytes = editor.font_manager.get_font_by_name("Basic")
        .unwrap_or_else(|| &editor.font_manager.font_data[0].1);

    // Position: Top-left, with some padding
    let start_x = 20.0;
    let start_y = 60.0;
    let line_height = 30.0;

    // Controls Header
    let header_id = Uuid::new_v4();
    let header_config = TextRendererConfig {
        id: header_id,
        name: "Controls Header".to_string(),
        text: "Controls:".to_string(),
        font_family: "Basic".to_string(),
        font_size: 24,
        dimensions: (200.0, 30.0),
        position: Point { x: start_x, y: start_y },
        layer: 100,
        color: [255, 255, 255, 255],
        background_fill: [0, 0, 0, 0],
    };
    
    let mut header_text = TextRenderer::new(
        device,
        queue,
        ui_model_bind_group_layout,
        group_bind_group_layout,
        font_bytes,
        &window_size,
        "Controls:".to_string(),
        header_config,
        header_id,
        Uuid::nil(),
        camera
    );

    header_text.render_text(device, queue);
    editor.ui_textboxes.push(header_text);

    // Inventory
    let inventory_id = Uuid::new_v4();
    let inventory_config = TextRendererConfig {
        id: inventory_id,
        name: "Controls Inventory".to_string(),
        text: "I - Inventory".to_string(),
        font_family: "Basic".to_string(),
        font_size: 20,
        dimensions: (200.0, 30.0),
        position: Point { x: start_x, y: start_y + line_height },
        layer: 100,
        color: [200, 200, 200, 255],
        background_fill: [0, 0, 0, 0],
    };

    let mut inventory_text = TextRenderer::new(
        device,
        queue,
        ui_model_bind_group_layout,
        group_bind_group_layout,
        font_bytes,
        &window_size,
        "I - Inventory".to_string(),
        inventory_config,
        inventory_id,
        Uuid::nil(),
        camera
    );

    inventory_text.render_text(device, queue);
    editor.ui_textboxes.push(inventory_text);

    // Interact
    let interact_id = Uuid::new_v4();
    let interact_config = TextRendererConfig {
        id: interact_id,
        name: "Controls Interact".to_string(),
        text: "E - Interact".to_string(),
        font_family: "Basic".to_string(),
        font_size: 20,
        dimensions: (200.0, 30.0),
        position: Point { x: start_x, y: start_y + line_height * 2.0 },
        layer: 100,
        color: [200, 200, 200, 255],
        background_fill: [0, 0, 0, 0],
    };

    let mut interact_text = TextRenderer::new(
        device,
        queue,
        ui_model_bind_group_layout,
        group_bind_group_layout,
        font_bytes,
        &window_size,
        "E - Interact".to_string(),
        interact_config,
        interact_id,
        Uuid::nil(),
        camera
    );

    interact_text.render_text(device, queue);
    editor.ui_textboxes.push(interact_text);
}
