use crate::core::editor::Editor;
use egui::{Ui, Rect, Pos2, Vec2, Color32, Stroke, Sense, Align2, FontId, Id};

pub struct VideoTimelineUi {
    pub zoom: f32, // ms per pixel
    pub scroll_x: f32,
    pub track_height: f32,
    pub header_height: f32,
    pub selected_ts_id: Option<String>,
}

impl VideoTimelineUi {
    pub fn new() -> Self {
        Self {
            zoom: 50.0, // 50ms per pixel
            scroll_x: 0.0,
            track_height: 50.0,
            header_height: 30.0,
            selected_ts_id: None,
        }
    }

    pub fn show(&mut self, ui: &mut Ui, editor: &mut Editor) {
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
                    
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                         ui.add(egui::Slider::new(&mut self.zoom, 1.0..=200.0).text("Zoom"));
                    });
                });

                ui.separator();

                // Main Timeline Area with horizontal scrolling
                egui::ScrollArea::horizontal().show(ui, |ui| {
                    let timeline_width = (editor.video_total_duration_ms as f32 / self.zoom).max(ui.available_width());
                    let (response, painter) = ui.allocate_painter(Vec2::new(timeline_width, 250.0), Sense::click_and_drag());
                    let timeline_rect = response.rect;

                    let time_to_x = |time_ms: i32| -> f32 {
                        timeline_rect.min.x + (time_ms as f32 / self.zoom)
                    };

                    let x_to_time = |x: f32| -> i32 {
                        ((x - timeline_rect.min.x) * self.zoom) as i32
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
                    for i in 0..6 {
                        let y = tracks_top + (i as f32 * self.track_height);
                        painter.line_segment(
                            [Pos2::new(timeline_rect.min.x, y), Pos2::new(timeline_rect.max.x, y)],
                            Stroke::new(1.0, Color32::from_rgb(50, 50, 50)),
                        );
                    }

                    // Draw Clips
                    let mut item_to_delete = None;
                    if let Some(world_state) = &mut editor.world_state {
                        
                        // Helper for rendering clips
                        let mut render_clip = |id: &str, name: &str, start_time: &mut i32, duration: i32, layer: i32, color: Color32, target_type: DeleteTarget| {
                            let track_idx = layer.clamp(0, 5);
                            let clip_start_x = time_to_x(*start_time);
                            let clip_width = (duration as f32 / self.zoom).max(5.0);
                            let clip_y = tracks_top + (track_idx as f32 * self.track_height) + 4.0;
                            let clip_rect = Rect::from_min_size(
                                Pos2::new(clip_start_x, clip_y),
                                Vec2::new(clip_width, self.track_height - 8.0)
                            );

                            let clip_id = Id::new("clip_v3").with(id);
                            let clip_res = ui.interact(clip_rect, clip_id, Sense::click_and_drag());
                            
                            if clip_res.clicked() {
                                self.selected_ts_id = Some(id.to_string());
                            }

                            if clip_res.dragged() {
                                let delta_x = clip_res.drag_delta().x;
                                let delta_time = (delta_x * self.zoom) as i32;
                                *start_time = (*start_time + delta_time).max(0);
                                self.selected_ts_id = Some(id.to_string());
                            }

                            clip_res.context_menu(|ui| {
                                if ui.button("Delete").clicked() {
                                    item_to_delete = Some(target_type);
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
                            
                            let text_rect = clip_rect.shrink(4.0);
                            let p = painter.with_clip_rect(clip_rect);
                            p.text(
                                text_rect.left_top(),
                                Align2::LEFT_TOP,
                                name,
                                FontId::proportional(11.0),
                                Color32::WHITE,
                            );
                        };

                        // Polygons
                        if let Some(polygons) = &mut world_state.active_polygons {
                            for (idx, poly) in polygons.iter_mut().enumerate() {
                                render_clip(&poly.id, &poly.name, &mut poly.start_time_ms, poly.duration_ms, poly.layer, Color32::from_rgb(60, 100, 180), DeleteTarget::Polygon(idx));
                            }
                        }

                        // Text
                        if let Some(text_items) = &mut world_state.active_text_items {
                            for (idx, text) in text_items.iter_mut().enumerate() {
                                render_clip(&text.id, &text.name, &mut text.start_time_ms, text.duration_ms, text.layer, Color32::from_rgb(100, 180, 60), DeleteTarget::Text(idx));
                            }
                        }

                        // Images
                        if let Some(images) = &mut world_state.active_image_items {
                            for (idx, img) in images.iter_mut().enumerate() {
                                render_clip(&img.id, &img.name, &mut img.start_time_ms, img.duration_ms, img.layer, Color32::from_rgb(180, 100, 60), DeleteTarget::Image(idx));
                            }
                        }

                        // Videos
                        if let Some(videos) = &mut world_state.active_video_items {
                            for (idx, vid) in videos.iter_mut().enumerate() {
                                render_clip(&vid.id, &vid.name, &mut vid.start_time_ms, vid.duration_ms, vid.layer, Color32::from_rgb(180, 60, 100), DeleteTarget::Video(idx));
                            }
                        }
                    }

                    if let Some(target) = item_to_delete {
                        if let Some(world_state) = &mut editor.world_state {
                            match target {
                                DeleteTarget::Polygon(idx) => { world_state.active_polygons.as_mut().map(|v| v.remove(idx)); },
                                DeleteTarget::Text(idx) => { world_state.active_text_items.as_mut().map(|v| v.remove(idx)); },
                                DeleteTarget::Image(idx) => { world_state.active_image_items.as_mut().map(|v| v.remove(idx)); },
                                DeleteTarget::Video(idx) => { world_state.active_video_items.as_mut().map(|v| v.remove(idx)); },
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
}
