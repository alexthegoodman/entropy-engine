use crate::core::editor::Editor;
use crate::shape_primitives::polygon::{SavedPolygonConfig, SavedPoint, SavedStroke};
use crate::renderer_text::text_due::SavedTextRendererConfig;
use crate::renderer_images::st_image::SavedStImageConfig;
use crate::vector_animations::animations::SavedStVideoConfig;
use egui::{Ui, Rect, Pos2, Vec2, Color32, Stroke, Sense, Align2, FontId, Id};
use uuid::Uuid;
use rfd::FileDialog;

pub struct VideoTimeline {
    pub zoom: f32, // ms per pixel
    pub scroll_x: f32,
    pub track_height: f32,
    pub header_height: f32,
    pub selected_ts_id: Option<String>,
    pub dragging_state: Option<DraggingState>,
    pub properties_open: bool,
}

#[derive(Clone, Copy, PartialEq)]
pub enum DraggingState {
    Moving,
    ResizingLeft,
    ResizingRight,
    DraggingKeyframe {
        anim_id: Uuid,
        prop_idx: usize,
        kf_idx: usize,
    },
}

impl VideoTimeline {
    pub fn new() -> Self {
        Self {
            zoom: 50.0, // 50ms per pixel
            scroll_x: 0.0,
            track_height: 50.0,
            header_height: 30.0,
            selected_ts_id: None,
            dragging_state: None,
            properties_open: true,
        }
    }

    pub fn show(&mut self, ui: &mut Ui, editor: &mut Editor) {
        // Sync selected_ts_id from editor.selected_object
        if let Some(selected) = &editor.selected_object {
            self.selected_ts_id = Some(selected.object_id.to_string());
        } else {
            // self.selected_ts_id = None; // Optional: deselect if nothing selected in viewport
        }

        egui::Frame::none()
            .fill(ui.visuals().window_fill())
            .stroke(ui.visuals().window_stroke())
            .show(ui, |ui| {
                ui.set_min_height(300.0);
                
                // Top bar: Controls
                ui.horizontal(|ui| {
                    ui.group(|ui| {
                        if ui.button(if editor.video_is_playing { "⏸" } else { "⏵" }).clicked() {
                            editor.video_is_playing = !editor.video_is_playing;
                        }
                        if ui.button("⏮").clicked() {
                            editor.video_current_time_ms = 0;
                        }
                        ui.label(format!("Time: {}ms", editor.video_current_time_ms));
                    });

                    ui.add_space(20.0);

                    if editor.stunts_state.is_some() {
                        ui.label("Add:");
                        if ui.button("Polygon").clicked() {
                            if let Some(stunts_state) = &mut editor.stunts_state {
                                let polygons = stunts_state.active_polygons.get_or_insert_with(Vec::new);
                                let settings = stunts_state.video_settings.clone().unwrap_or_default();
                                let default_size = 100;
                                let center = SavedPoint {
                                    x: (settings.render_size.width - default_size) / 2,
                                    y: (settings.render_size.height - default_size) / 2
                                };
                                polygons.push(SavedPolygonConfig {
                                    id: Uuid::new_v4().to_string(),
                                    name: format!("Polygon {}", polygons.len() + 1),
                                    fill: [255, 255, 255, 255],
                                    dimensions: (default_size, default_size),
                                    position: center,
                                    border_radius: 0,
                                    stroke: SavedStroke { thickness: 0, fill: [0, 0, 0, 255] },
                                    layer: 0,
                                    start_time_ms: editor.video_current_time_ms,
                                    duration_ms: 3000,
                                });
                            }
                            editor.sync_stunts_objects();
                        }
                        if ui.button("Text").clicked() {
                            if let Some(stunts_state) = &mut editor.stunts_state {
                                let text_items = stunts_state.active_text_items.get_or_insert_with(Vec::new);
                                let settings = stunts_state.video_settings.clone().unwrap_or_default();
                                let default_size = (200, 50);
                                let center = SavedPoint {
                                    x: (settings.render_size.width - default_size.0) / 2,
                                    y: (settings.render_size.height - default_size.1) / 2
                                };
                                text_items.push(SavedTextRendererConfig {
                                    id: Uuid::new_v4().to_string(),
                                    name: format!("Text {}", text_items.len() + 1),
                                    text: "New Text".to_string(),
                                    font_family: "Aleo".to_string(),
                                    font_size: 32,
                                    dimensions: default_size,
                                    position: center,
                                    layer: 1,
                                    color: [255, 255, 255, 255],
                                    background_fill: None,
                                    start_time_ms: editor.video_current_time_ms,
                                    duration_ms: 3000,
                                });
                            }
                            editor.sync_stunts_objects();
                        }
                        if ui.button("Image").clicked() {
                            if let Some(path) = FileDialog::new()
                                .add_filter("Image", &["png", "jpg", "jpeg"])
                                .pick_file() 
                            {
                                if let Some(stunts_state) = &mut editor.stunts_state {
                                    let images = stunts_state.active_image_items.get_or_insert_with(Vec::new);
                                    let settings = stunts_state.video_settings.clone().unwrap_or_default();
                                    let default_size = (200, 200);
                                    let center = SavedPoint {
                                        x: (settings.render_size.width - default_size.0) / 2,
                                        y: (settings.render_size.height - default_size.1) / 2
                                    };
                                    images.push(SavedStImageConfig {
                                        id: Uuid::new_v4().to_string(),
                                        name: path.file_name().unwrap().to_string_lossy().to_string(),
                                        path: path.to_string_lossy().to_string(),
                                        dimensions: (default_size.0 as u32, default_size.1 as u32),
                                        position: center,
                                        layer: 2,
                                        start_time_ms: editor.video_current_time_ms,
                                        duration_ms: 3000,
                                    });
                                }
                                editor.sync_stunts_objects();
                            }
                        }
                        if ui.button("Video").clicked() {
                            if let Some(path) = FileDialog::new()
                                .add_filter("Video", &["mp4"])
                                .pick_file() 
                            {
                                if let Some(stunts_state) = &mut editor.stunts_state {
                                    let videos = stunts_state.active_video_items.get_or_insert_with(Vec::new);
                                    let settings = stunts_state.video_settings.clone().unwrap_or_default();
                                    let default_size = (320, 180);
                                    let center = SavedPoint {
                                        x: (settings.render_size.width - default_size.0) / 2,
                                        y: (settings.render_size.height - default_size.1) / 2
                                    };
                                    videos.push(SavedStVideoConfig {
                                        id: Uuid::new_v4().to_string(),
                                        name: path.file_name().unwrap().to_string_lossy().to_string(),
                                        path: path.to_string_lossy().to_string(),
                                        dimensions: (default_size.0 as u32, default_size.1 as u32),
                                        position: center,
                                        layer: 3,
                                        mouse_path: None,
                                        start_time_ms: editor.video_current_time_ms,
                                        duration_ms: 5000,
                                    });
                                }
                                editor.sync_stunts_objects();
                            }
                        }
                        
                        ui.separator();
                        ui.toggle_value(&mut self.properties_open, "Properties");
                    }
                    
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                         ui.add(egui::Slider::new(&mut self.zoom, 1.0..=200.0).text("Zoom"));
                    });
                });

                ui.separator();

                // Main Timeline Area with horizontal scrolling
                egui::ScrollArea::both().show(ui, |ui| {
                    let mut timeline_height = 300.0;
                    if self.properties_open && self.selected_ts_id.is_some() {
                        if let Some(stunts_state) = &editor.stunts_state {
                            if let Some(animation_paths) = &stunts_state.object_motion_paths {
                                if let Some(anim) = animation_paths.iter().find(|a| a.polygon_id == self.selected_ts_id.as_ref().unwrap().as_str()) {
                                    timeline_height += anim.properties.len() as f32 * 25.0 + 20.0;
                                }
                            }
                        }
                    }

                    let timeline_width = (editor.video_total_duration_ms as f32 / self.zoom).max(ui.available_width());
                    let (response, painter) = ui.allocate_painter(Vec2::new(timeline_width, timeline_height), Sense::click_and_drag());
                    let timeline_rect = response.rect;

                    let time_to_x = |time_ms: i32| -> f32 {
                        timeline_rect.min.x + (time_ms as f32 / self.zoom)
                    };

                    let x_to_time = |x: f32| -> i32 {
                        ((x - timeline_rect.min.x) * self.zoom) as i32
                    };

                    let snap_to_playhead = |time_ms: i32| -> i32 {
                        let snap_threshold = (5.0 * self.zoom) as i32; // 5 pixels snap
                        if (time_ms - editor.video_current_time_ms).abs() < snap_threshold {
                            editor.video_current_time_ms
                        } else {
                            time_ms
                        }
                    };

                    // Background
                    painter.rect_filled(timeline_rect, 0.0, Color32::from_rgb(25, 25, 25));

                    // Ruler
                    let ruler_rect = Rect::from_min_size(timeline_rect.min, Vec2::new(timeline_rect.width(), self.header_height));
                    painter.rect_filled(ruler_rect, 0.0, Color32::from_rgb(40, 40, 40));
                    
                    // Ruler Ticks
                    let tick_interval_ms = if self.zoom < 10.0 { 100 } else if self.zoom < 50.0 { 500 } else { 1000 };
                    let mut current_tick = 0;
                    while current_tick <= editor.video_total_duration_ms {
                        let x = time_to_x(current_tick);
                        let is_major = current_tick % 1000 == 0;
                        let tick_height = if is_major { 15.0 } else { 8.0 };
                        
                        painter.line_segment(
                            [Pos2::new(x, ruler_rect.min.y), Pos2::new(x, ruler_rect.min.y + tick_height)],
                            Stroke::new(1.0, Color32::GRAY),
                        );

                        if is_major {
                            painter.text(
                                Pos2::new(x + 2.0, ruler_rect.min.y + 2.0),
                                Align2::LEFT_TOP,
                                format!("{}s", current_tick / 1000),
                                FontId::monospace(10.0),
                                Color32::GRAY,
                            );
                        }
                        current_tick += tick_interval_ms;
                    }

                    // Seek interaction
                    if response.dragged() || response.clicked() {
                        if let Some(pointer_pos) = response.interact_pointer_pos() {
                            if ruler_rect.contains(pointer_pos) {
                                editor.video_current_time_ms = x_to_time(pointer_pos.x).clamp(0, editor.video_total_duration_ms);
                            }
                        }
                    }

                    // Tracks lines
                    let tracks_top = timeline_rect.min.y + self.header_height;
                    let mut current_y = tracks_top;
                    
                    // Main tracks
                    for i in 0..6 {
                        let y = tracks_top + (i as f32 * self.track_height);
                        painter.line_segment(
                            [Pos2::new(timeline_rect.min.x, y), Pos2::new(timeline_rect.max.x, y)],
                            Stroke::new(1.0, Color32::from_rgb(50, 50, 50)),
                        );
                    }
                    current_y += 6.0 * self.track_height;

                    // Draw Clips
                    let mut item_to_delete = None;
                    if let Some(stunts_state) = &mut editor.stunts_state {
                        
                        // Helper for rendering clips
                        let mut render_clip = |id: &str, name: &str, start_time: &mut i32, duration: &mut i32, layer: i32, color: Color32, target_type: DeleteTarget| {
                            let track_idx = layer.clamp(0, 5);
                            let clip_start_x = time_to_x(*start_time);
                            let clip_width = (*duration as f32 / self.zoom).max(5.0);
                            let clip_y = tracks_top + (track_idx as f32 * self.track_height) + 4.0;
                            let clip_rect = Rect::from_min_size(
                                Pos2::new(clip_start_x, clip_y),
                                Vec2::new(clip_width, self.track_height - 8.0)
                            );

                            let clip_id = Id::new("clip_v3").with(id);
                            let clip_res = ui.interact(clip_rect, clip_id, Sense::click_and_drag());
                            
                            // Edge detection for resizing
                            let edge_threshold = 8.0;
                            let is_on_left_edge = clip_res.hovered() && ui.input(|i| i.pointer.hover_pos()).map_or(false, |pos| pos.x < clip_rect.min.x + edge_threshold);
                            let is_on_right_edge = clip_res.hovered() && ui.input(|i| i.pointer.hover_pos()).map_or(false, |pos| pos.x > clip_rect.max.x - edge_threshold);

                            if is_on_left_edge || is_on_right_edge {
                                ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::ResizeHorizontal);
                            }

                            if clip_res.drag_started() {
                                if is_on_left_edge {
                                    self.dragging_state = Some(DraggingState::ResizingLeft);
                                } else if is_on_right_edge {
                                    self.dragging_state = Some(DraggingState::ResizingRight);
                                } else {
                                    self.dragging_state = Some(DraggingState::Moving);
                                }
                            }

                            if clip_res.drag_stopped() {
                                self.dragging_state = None;
                            }

                            if clip_res.clicked() {
                                self.selected_ts_id = Some(id.to_string());
                                // Sync with editor selection
                                let obj_type = match target_type {
                                    DeleteTarget::Polygon(_) => Some(crate::vector_animations::animations::ObjectType::Polygon),
                                    DeleteTarget::Text(_) => Some(crate::vector_animations::animations::ObjectType::TextItem),
                                    DeleteTarget::Image(_) => Some(crate::vector_animations::animations::ObjectType::ImageItem),
                                    DeleteTarget::Video(_) => Some(crate::vector_animations::animations::ObjectType::VideoItem),
                                    _ => None
                                };
                                if let Some(obj_type) = obj_type {
                                    editor.selected_object = Some(crate::core::editor::SelectedObject {
                                        object_id: Uuid::parse_str(id).unwrap_or_default(),
                                        object_type: obj_type,
                                    });
                                }
                            }

                            if clip_res.dragged() {
                                let delta_x = clip_res.drag_delta().x;
                                let delta_time = (delta_x * self.zoom) as i32;

                                match self.dragging_state {
                                    Some(DraggingState::Moving) => {
                                        let new_start = *start_time + delta_time;
                                        *start_time = snap_to_playhead(new_start).max(0);
                                    }
                                    Some(DraggingState::ResizingLeft) => {
                                        let new_start = *start_time + delta_time;
                                        let snapped_start = snap_to_playhead(new_start).max(0);
                                        let actual_delta = snapped_start - *start_time;
                                        if *duration - actual_delta > 10 {
                                            *start_time = snapped_start;
                                            *duration -= actual_delta;
                                        }
                                    }
                                    Some(DraggingState::ResizingRight) => {
                                        let new_duration = *duration + delta_time;
                                        let snapped_end = snap_to_playhead(*start_time + new_duration);
                                        *duration = (snapped_end - *start_time).max(10);
                                    }
                                    _ => {}
                                }

                                self.selected_ts_id = Some(id.to_string());
                                // Sync with editor selection
                                let obj_type = match target_type {
                                    DeleteTarget::Polygon(_) => Some(crate::vector_animations::animations::ObjectType::Polygon),
                                    DeleteTarget::Text(_) => Some(crate::vector_animations::animations::ObjectType::TextItem),
                                    DeleteTarget::Image(_) => Some(crate::vector_animations::animations::ObjectType::ImageItem),
                                    DeleteTarget::Video(_) => Some(crate::vector_animations::animations::ObjectType::VideoItem),
                                    _ => None
                                };
                                if let Some(obj_type) = obj_type {
                                    editor.selected_object = Some(crate::core::editor::SelectedObject {
                                        object_id: Uuid::parse_str(id).unwrap_or_default(),
                                        object_type: obj_type,
                                    });
                                }
                            }

                            clip_res.context_menu(|ui| {
                                if ui.button("Delete").clicked() {
                                    item_to_delete = Some(target_type);
                                    ui.close_menu();
                                }
                                if ui.button("Clear All Animation").clicked() {
                                    if let Some(stunts_state) = &mut editor.stunts_state {
                                        if let Some(paths) = &mut stunts_state.object_motion_paths {
                                            paths.retain(|p| p.polygon_id != id);
                                        }
                                    }
                                    ui.close_menu();
                                }
                            });

                            let is_selected = self.selected_ts_id.as_ref() == Some(&id.to_string());
                            let mut fill_color = color;
                            if is_selected {
                                fill_color = fill_color.linear_multiply(1.5);
                            }

                            painter.rect_filled(clip_rect, 2.0, fill_color);
                            let stroke_color = if is_selected { Color32::WHITE } else { Color32::from_rgb(200, 200, 200) };
                            painter.rect_stroke(clip_rect, 2.0, Stroke::new(if is_selected { 2.0 } else { 1.0 }, stroke_color), egui::StrokeKind::Middle);
                            
                            // Visual feedback for edges
                            if is_selected {
                                painter.line_segment([clip_rect.left_top(), clip_rect.left_bottom()], Stroke::new(2.0, Color32::WHITE));
                                painter.line_segment([clip_rect.right_top(), clip_rect.right_bottom()], Stroke::new(2.0, Color32::WHITE));
                            }

                            let text_rect = clip_rect.shrink(4.0);
                            let p = painter.with_clip_rect(clip_rect);
                            p.text(
                                text_rect.left_top(),
                                Align2::LEFT_TOP,
                                name,
                                FontId::proportional(11.0),
                                Color32::WHITE,
                            );

                            // Draw Keyframes if they exist for this object
                            if let Some(stunts_state) = &editor.stunts_state {
                                if let Some(animation_paths) = &stunts_state.object_motion_paths {
                                    if let Some(anim) = animation_paths.iter().find(|a| a.polygon_id == id) {
                                        for prop in &anim.properties {
                                            for kf in &prop.keyframes {
                                                let kf_time_ms = kf.time.as_millis() as i32;
                                                let kf_x = time_to_x(*start_time + kf_time_ms);
                                                
                                                // Diamond shape for keyframe
                                                let kf_pos = Pos2::new(kf_x, clip_rect.bottom() - 4.0);
                                                let diamond_points = vec![
                                                    Pos2::new(kf_pos.x, kf_pos.y - 4.0),
                                                    Pos2::new(kf_pos.x + 4.0, kf_pos.y),
                                                    Pos2::new(kf_pos.x, kf_pos.y + 4.0),
                                                    Pos2::new(kf_pos.x - 4.0, kf_pos.y),
                                                ];
                                                painter.add(egui::Shape::convex_polygon(
                                                    diamond_points,
                                                    Color32::WHITE,
                                                    Stroke::new(1.0, Color32::BLACK)
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                        };

                        // Polygons
                        if let Some(polygons) = &mut stunts_state.active_polygons {
                            for (idx, poly) in polygons.iter_mut().enumerate() {
                                render_clip(&poly.id, &poly.name, &mut poly.start_time_ms, &mut poly.duration_ms, poly.layer, Color32::from_rgb(60, 100, 180), DeleteTarget::Polygon(idx));
                            }
                        }

                        // Text
                        if let Some(text_items) = &mut stunts_state.active_text_items {
                            for (idx, text) in text_items.iter_mut().enumerate() {
                                render_clip(&text.id, &text.name, &mut text.start_time_ms, &mut text.duration_ms, text.layer, Color32::from_rgb(100, 180, 60), DeleteTarget::Text(idx));
                            }
                        }

                        // Images
                        if let Some(images) = &mut stunts_state.active_image_items {
                            for (idx, img) in images.iter_mut().enumerate() {
                                render_clip(&img.id, &img.name, &mut img.start_time_ms, &mut img.duration_ms, img.layer, Color32::from_rgb(180, 100, 60), DeleteTarget::Image(idx));
                            }
                        }

                        // Videos
                        if let Some(videos) = &mut stunts_state.active_video_items {
                            for (idx, vid) in videos.iter_mut().enumerate() {
                                render_clip(&vid.id, &vid.name, &mut vid.start_time_ms, &mut vid.duration_ms, vid.layer, Color32::from_rgb(180, 60, 100), DeleteTarget::Video(idx));
                            }
                        }

                        // Property tracks for selected item
                        if self.properties_open {
                            if let Some(selected_id) = &self.selected_ts_id {
                                if let Some(animation_paths) = &mut stunts_state.object_motion_paths {
                                    if let Some(anim_idx) = animation_paths.iter().position(|a| a.polygon_id == *selected_id) {
                                        let anim = &mut animation_paths[anim_idx];
                                        let anim_uuid = Uuid::parse_str(&anim.id).unwrap_or_default();
                                        
                                        // Header
                                        painter.rect_filled(
                                            Rect::from_min_size(Pos2::new(timeline_rect.min.x, current_y), Vec2::new(timeline_rect.width(), 20.0)),
                                            0.0,
                                            Color32::from_rgb(35, 35, 35)
                                        );
                                        painter.text(
                                            Pos2::new(timeline_rect.min.x + 5.0, current_y + 2.0),
                                            Align2::LEFT_TOP,
                                            "Properties",
                                            FontId::proportional(12.0),
                                            Color32::LIGHT_GRAY
                                        );
                                        current_y += 20.0;

                                        let start_time_ms = stunts_state.active_polygons.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.start_time_ms)
                                            .or_else(|| stunts_state.active_text_items.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.start_time_ms))
                                            .or_else(|| stunts_state.active_image_items.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.start_time_ms))
                                            .or_else(|| stunts_state.active_video_items.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.start_time_ms))
                                            .unwrap_or(0);
                                        let duration_ms = stunts_state.active_polygons.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.duration_ms)
                                            .or_else(|| stunts_state.active_text_items.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.duration_ms))
                                            .or_else(|| stunts_state.active_image_items.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.duration_ms))
                                            .or_else(|| stunts_state.active_video_items.as_ref().and_then(|v| v.iter().find(|p| p.id == *selected_id)).map(|p| p.duration_ms))
                                            .unwrap_or(0);

                                        // Tracks
                                        for prop_idx in 0..anim.properties.len() {
                                            let prop = &mut anim.properties[prop_idx];
                                            let track_rect = Rect::from_min_size(Pos2::new(timeline_rect.min.x, current_y), Vec2::new(timeline_rect.width(), 25.0));
                                            let track_id = Id::new("prop_track").with(anim_uuid).with(prop_idx);
                                            let track_res = ui.interact(track_rect, track_id, Sense::click_and_drag());
                                            
                                            painter.rect_filled(track_rect, 0.0, Color32::from_rgb(30, 30, 30));
                                            painter.line_segment(
                                                [Pos2::new(timeline_rect.min.x, current_y + 25.0), Pos2::new(timeline_rect.max.x, current_y + 25.0)],
                                                Stroke::new(1.0, Color32::from_rgb(45, 45, 45))
                                            );
                                            
                                            painter.text(
                                                Pos2::new(timeline_rect.min.x + 15.0, current_y + 5.0),
                                                Align2::LEFT_TOP,
                                                &prop.name,
                                                FontId::proportional(11.0),
                                                Color32::GRAY
                                            );

                                            track_res.context_menu(|ui| {
                                                if ui.button("Add Keyframe at Playhead").clicked() {
                                                    let kf_time = (editor.video_current_time_ms - start_time_ms).clamp(0, duration_ms);
                                                    prop.keyframes.push(crate::vector_animations::animations::UIKeyframe {
                                                        id: Uuid::new_v4().to_string(),
                                                        time: std::time::Duration::from_millis(kf_time as u64),
                                                        ..Default::default()
                                                    });
                                                    prop.keyframes.sort_by_key(|k| k.time);
                                                    ui.close_menu();
                                                }
                                            });

                                            // Draw keyframes for this specific property
                                            for kf_idx in 0..prop.keyframes.len() {
                                                let kf = &mut prop.keyframes[kf_idx];
                                                let kf_time_ms = kf.time.as_millis() as i32;
                                                let kf_x = time_to_x(start_time_ms + kf_time_ms);
                                                let kf_pos = Pos2::new(kf_x, current_y + 12.5);
                                                let kf_rect = Rect::from_center_size(kf_pos, Vec2::new(10.0, 10.0));
                                                
                                                let kf_id = Id::new("kf_drag").with(anim_uuid).with(prop_idx).with(kf_idx);
                                                let kf_res = ui.interact(kf_rect, kf_id, Sense::drag());

                                                if kf_res.drag_started() {
                                                    self.dragging_state = Some(DraggingState::DraggingKeyframe {
                                                        anim_id: anim_uuid,
                                                        prop_idx,
                                                        kf_idx,
                                                    });
                                                }

                                                if kf_res.dragged() {
                                                    let delta_x = kf_res.drag_delta().x;
                                                    let delta_time = (delta_x * self.zoom) as i32;
                                                    let new_time_ms = (kf_time_ms + delta_time).clamp(0, duration_ms);
                                                    let snapped_time = snap_to_playhead(start_time_ms + new_time_ms) - start_time_ms;
                                                    kf.time = std::time::Duration::from_millis(snapped_time.clamp(0, duration_ms) as u64);
                                                }

                                                if kf_res.drag_stopped() {
                                                    self.dragging_state = None;
                                                    prop.keyframes.sort_by_key(|k| k.time);
                                                }

                                                kf_res.context_menu(|ui| {
                                                    if ui.button("Delete Keyframe").clicked() {
                                                        item_to_delete = Some(DeleteTarget::Keyframe { anim_idx, prop_idx, kf_idx });
                                                        ui.close_menu();
                                                    }
                                                });

                                                let diamond_points = vec![
                                                    Pos2::new(kf_pos.x, kf_pos.y - 5.0),
                                                    Pos2::new(kf_pos.x + 5.0, kf_pos.y),
                                                    Pos2::new(kf_pos.x, kf_pos.y + 5.0),
                                                    Pos2::new(kf_pos.x - 5.0, kf_pos.y),
                                                ];
                                                painter.add(egui::Shape::convex_polygon(
                                                    diamond_points,
                                                    if kf_res.hovered() || kf_res.dragged() { Color32::WHITE } else { Color32::from_rgb(200, 200, 200) },
                                                    Stroke::new(1.0, Color32::BLACK)
                                                ));
                                            }

                                            current_y += 25.0;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if let Some(target) = item_to_delete {
                        if let Some(stunts_state) = &mut editor.stunts_state {
                            match target {
                                DeleteTarget::Polygon(idx) => { stunts_state.active_polygons.as_mut().map(|v| v.remove(idx)); },
                                DeleteTarget::Text(idx) => { stunts_state.active_text_items.as_mut().map(|v| v.remove(idx)); },
                                DeleteTarget::Image(idx) => { stunts_state.active_image_items.as_mut().map(|v| v.remove(idx)); },
                                DeleteTarget::Video(idx) => { stunts_state.active_video_items.as_mut().map(|v| v.remove(idx)); },
                                DeleteTarget::Keyframe { anim_idx, prop_idx, kf_idx } => {
                                    if let Some(paths) = &mut stunts_state.object_motion_paths {
                                        if let Some(anim) = paths.get_mut(anim_idx) {
                                            if let Some(prop) = anim.properties.get_mut(prop_idx) {
                                                if kf_idx < prop.keyframes.len() {
                                                    prop.keyframes.remove(kf_idx);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Playhead line
                    let ph_x = time_to_x(editor.video_current_time_ms);
                    painter.line_segment(
                        [Pos2::new(ph_x, timeline_rect.min.y), Pos2::new(ph_x, timeline_rect.max.y)],
                        Stroke::new(1.5, Color32::from_rgb(255, 50, 50)),
                    );
                    
                    // Playhead handle
                    let ph_handle_rect = Rect::from_center_size(
                        Pos2::new(ph_x, timeline_rect.min.y + self.header_height / 2.0),
                        Vec2::new(12.0, 18.0)
                    );
                    painter.rect_filled(ph_handle_rect, 2.0, Color32::from_rgb(255, 50, 50));
                });
            });
    }
}

#[derive(Clone, Copy)]

enum DeleteTarget {

    Polygon(usize),

    Text(usize),

    Image(usize),

    Video(usize),

    Keyframe {

        anim_idx: usize,

        prop_idx: usize,

        kf_idx: usize,

    },

}
