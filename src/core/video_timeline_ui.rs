use crate::core::editor::Editor;
use crate::helpers::timelines::{TimelineSequence, TrackType, SavedTimelineStateConfig};
use crate::vector_animations::animations::Sequence;
use egui::{Ui, Rect, Pos2, Vec2, Color32, Stroke, Sense, PointerButton, Align2, FontId, Id, Shape, LayerId, Order};
use uuid::Uuid;

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
        let available_rect = ui.available_rect_before_wrap();
        
        egui::Frame::none()
            .fill(ui.visuals().window_fill())
            .stroke(ui.visuals().window_stroke())
            .show(ui, |ui| {
                ui.set_min_height(300.0);
                
                // Top bar: Controls and Clips Library
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

                    // Library of sequences that can be added
                    ui.label("Add Sequence:");
                    if let Some(world_state) = &mut editor.world_state {
                        if let Some(sequences) = &world_state.sequences {
                            for seq in sequences {
                                if ui.button(&seq.name).on_hover_text("Add to timeline").clicked() {
                                    if world_state.timeline_state.is_none() {
                                        world_state.timeline_state = Some(SavedTimelineStateConfig::default());
                                    }
                                    if let Some(ts_config) = &mut world_state.timeline_state {
                                        ts_config.timeline_sequences.push(TimelineSequence {
                                            id: Uuid::new_v4().to_string(),
                                            sequence_id: seq.id.clone(),
                                            track_type: TrackType::Video,
                                            track_index: 0,
                                            start_time_ms: editor.video_current_time_ms,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    
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
                    let mut ts_to_delete = None;
                    if let Some(world_state) = &mut editor.world_state {
                        if let Some(timeline_state) = &mut world_state.timeline_state {
                            let sequences_map = world_state.sequences.as_ref().map(|s| {
                                s.iter().map(|seq| (seq.id.clone(), seq)).collect::<std::collections::HashMap<_, _>>()
                            }).unwrap_or_default();

                            for (idx, ts) in timeline_state.timeline_sequences.iter_mut().enumerate() {
                                if let Some(seq) = sequences_map.get(&ts.sequence_id) {
                                    let track_idx = match ts.track_type {
                                        TrackType::Video => ts.track_index.min(2),
                                        TrackType::Audio => 3 + ts.track_index.min(2),
                                    };

                                    let clip_start_x = time_to_x(ts.start_time_ms);
                                    let clip_width = (seq.duration_ms as f32 / self.zoom).max(5.0);
                                    let clip_y = tracks_top + (track_idx as f32 * self.track_height) + 4.0;
                                    let clip_rect = Rect::from_min_size(
                                        Pos2::new(clip_start_x, clip_y),
                                        Vec2::new(clip_width, self.track_height - 8.0)
                                    );

                                    let clip_id = Id::new("clip_v2").with(&ts.id);
                                    let clip_res = ui.interact(clip_rect, clip_id, Sense::click_and_drag());
                                    
                                    if clip_res.clicked() {
                                        self.selected_ts_id = Some(ts.id.clone());
                                    }

                                    if clip_res.dragged() {
                                        let delta_x = clip_res.drag_delta().x;
                                        let delta_time = (delta_x * self.zoom) as i32;
                                        ts.start_time_ms = (ts.start_time_ms + delta_time).max(0);
                                        self.selected_ts_id = Some(ts.id.clone());
                                    }

                                    clip_res.context_menu(|ui| {
                                        if ui.button("Delete Clip").clicked() {
                                            ts_to_delete = Some(idx);
                                            ui.close_menu();
                                        }
                                    });

                                    let is_selected = self.selected_ts_id.as_ref() == Some(&ts.id);
                                    let mut fill_color = if ts.track_type == TrackType::Video {
                                        Color32::from_rgb(60, 100, 180)
                                    } else {
                                        Color32::from_rgb(100, 180, 60)
                                    };
                                    
                                    if is_selected {
                                        fill_color = fill_color.linear_multiply(1.5);
                                    }

                                    painter.rect_filled(clip_rect, 2.0, fill_color);
                                    let stroke_color = if is_selected { Color32::WHITE } else { Color32::from_rgb(200, 200, 200) };
                                    painter.rect_stroke(clip_rect, 2.0, Stroke::new(if is_selected { 2.0 } else { 1.0 }, stroke_color), egui::StrokeKind::Middle);
                                    
                                    // Clip Name
                                    let text_rect = clip_rect.shrink(4.0);
                                    let p = painter.with_clip_rect(clip_rect);
                                    p.text(
                                        text_rect.left_top(),
                                        Align2::LEFT_TOP,
                                        &seq.name,
                                        FontId::proportional(11.0),
                                        Color32::WHITE,
                                    );
                                }
                            }
                        }
                    }

                    if let Some(idx) = ts_to_delete {
                        if let Some(world_state) = &mut editor.world_state {
                            if let Some(ts_config) = &mut world_state.timeline_state {
                                ts_config.timeline_sequences.remove(idx);
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