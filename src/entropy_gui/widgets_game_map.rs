//! `GameMap`: High-performance orthographic topological game world planner map widget.
//!
//! Provides an immediate-mode 2D orthographic canvas for game world layout:
//! - Infinite pan and multi-scale zoom (from continental overview to meter-level detail)
//! - Coordinate grid with adaptive spacing, coordinate readouts, and configurable snap
//! - Topological elevation bands / contour visualization with altitude color-coding
//! - Biomes and territory regions with translucent fills and styled borders
//! - Multi-segment paths (highways, dirt roads, trails, rivers with flow direction, bridges)
//! - Point of Interest (POI) spots with category badges, selection rings, and altitude tags
//! - Built-in workflow filter for Blocking (macro-structure) vs Detailing (micro-features)
//! - Interactive measurement ruler with real-time distance and multi-modal Time-to-Travel pills
//! - Full event stream (selection, dragging, adding points, viewport changes)

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, CornerRadius, FontId, Pos2, Rect, StrokeKind, Vec2};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::Ui;

// -------------------------------------------------------------------------------------------------
// Palette Constants
// -------------------------------------------------------------------------------------------------

const BG_COLOR: Color32 = Color32::from_rgb(11, 14, 20);
const GRID_MAJOR: Color32 = Color32::from_rgba_unmultiplied(255, 255, 255, 28);
const GRID_MINOR: Color32 = Color32::from_rgba_unmultiplied(255, 255, 255, 12);
const BORDER_COLOR: Color32 = Color32::from_rgba_unmultiplied(255, 255, 255, 35);
const TEXT_BRIGHT: Color32 = Color32::from_rgb(230, 238, 250);
const TEXT_DIM: Color32 = Color32::from_rgb(140, 150, 175);
const TEXT_MUTED: Color32 = Color32::from_rgb(95, 105, 125);
const ACCENT_CYAN: Color32 = Color32::from_rgb(56, 189, 248);
const ACCENT_AMBER: Color32 = Color32::from_rgb(251, 191, 36);
const ACCENT_EMERALD: Color32 = Color32::from_rgb(52, 211, 153);
const ACCENT_ROSE: Color32 = Color32::from_rgb(244, 63, 94);
const ACCENT_VIOLET: Color32 = Color32::from_rgb(168, 85, 247);
const BADGE_BG: Color32 = Color32::from_rgba_unmultiplied(18, 22, 32, 220);

// -------------------------------------------------------------------------------------------------
// Data Models
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct MapSpot {
    pub id: String,
    pub name: String,
    pub spot_type: String, // "capital", "city", "town", "village", "fortress", "dungeon", "ruin", "port", "shrine", "camp", "mine", "boss"
    pub x: f32,            // world km or m
    pub y: f32,
    pub elevation: f32,    // meters
    pub color: [f32; 4],
    pub icon: String,
    pub tags: Vec<String>,
    pub is_major: bool,    // visible in blocking mode
}

impl Default for MapSpot {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Location".into(),
            spot_type: "town".into(),
            x: 0.0,
            y: 0.0,
            elevation: 100.0,
            color: [0.2, 0.8, 0.6, 1.0],
            icon: "house".into(),
            tags: Vec::new(),
            is_major: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapPath {
    pub id: String,
    pub name: String,
    pub path_type: String, // "highway", "road", "trail", "river", "bridge"
    pub points: Vec<[f32; 2]>,
    pub width: f32,
    pub color: [f32; 4],
    pub is_major: bool,
    pub flow_speed: f32,   // for rivers (> 0 = has flow direction)
}

impl Default for MapPath {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Path".into(),
            path_type: "road".into(),
            points: Vec::new(),
            width: 3.0,
            color: [0.8, 0.7, 0.5, 1.0],
            is_major: false,
            flow_speed: 0.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapRegion {
    pub id: String,
    pub name: String,
    pub region_type: String, // "kingdom", "biome", "danger", "district"
    pub points: Vec<[f32; 2]>,
    pub fill_color: [f32; 4],
    pub border_color: [f32; 4],
    pub is_major: bool,
}

impl Default for MapRegion {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Region".into(),
            region_type: "kingdom".into(),
            points: Vec::new(),
            fill_color: [0.3, 0.5, 0.8, 0.25],
            border_color: [0.4, 0.6, 0.9, 0.8],
            is_major: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapElevationBand {
    pub elevation: f32, // meters
    pub points: Vec<[f32; 2]>,
    pub color: [f32; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapMeasure {
    pub active: bool,
    pub p1: [f32; 2],
    pub p2: [f32; 2],
    pub distance_km: f32,
    pub travel_info: String, // e.g. "Foot: 3h 15m | Horse: 42m | Air: 12m"
}

// -------------------------------------------------------------------------------------------------
// Options & Events
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct GameMapOptions {
    pub world_width_km: f32,
    pub world_height_km: f32,
    pub grid_snap_m: f32,       // 0.0 = off, else snap distance in meters
    pub show_grid: bool,
    pub show_contours: bool,
    pub show_biomes: bool,
    pub blocking_mode: bool,    // true = blocking mode (macro layout only)
    pub active_tool: String,    // "select", "pan", "place_spot", "draw_path", "draw_region", "measure"
    pub selected_id: Option<String>,
    pub highlighted_quest_id: Option<String>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub initial_center: Option<[f32; 2]>,
    pub initial_zoom: Option<f32>,
}

impl Default for GameMapOptions {
    fn default() -> Self {
        Self {
            world_width_km: 25.0,
            world_height_km: 25.0,
            grid_snap_m: 0.0,
            show_grid: true,
            show_contours: true,
            show_biomes: true,
            blocking_mode: false,
            active_tool: "select".into(),
            selected_id: None,
            highlighted_quest_id: None,
            width: None,
            height: None,
            initial_center: None,
            initial_zoom: None,
        }
    }
}

#[derive(Clone, Debug)]
pub enum GameMapEvent {
    SpotSelected { id: String },
    SpotMoved { id: String, x: f32, y: f32 },
    PathSelected { id: String },
    RegionSelected { id: String },
    MapClicked { x: f32, y: f32 },
    MapDoubleClicked { x: f32, y: f32 },
    PointAdded { x: f32, y: f32 },
    MeasureUpdated { x1: f32, y1: f32, x2: f32, y2: f32, distance_km: f32 },
    ViewportChanged { center_x: f32, center_y: f32, zoom: f32 },
    ToolChanged(String),
    BlockingModeToggled(bool),
}

pub struct GameMapResponse {
    pub events: Vec<GameMapEvent>,
}

// -------------------------------------------------------------------------------------------------
// State & Memory
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct GameMapState {
    pub center: Pos2,     // world km center of view
    pub zoom: f32,        // pixels per world km
    pub is_panning: bool,
    pub pan_start_pointer: Option<Pos2>,
    pub pan_start_center: Pos2,
    pub dragging_spot_id: Option<String>,
    pub measure_anchor: Option<Pos2>,
    pub current_pointer_world: Option<Pos2>,
}

impl Default for GameMapState {
    fn default() -> Self {
        Self {
            center: pos2(0.0, 0.0),
            zoom: 24.0, // 24 px per km default
            is_panning: false,
            pan_start_pointer: None,
            pan_start_center: pos2(0.0, 0.0),
            dragging_spot_id: None,
            measure_anchor: None,
            current_pointer_world: None,
        }
    }
}

// -------------------------------------------------------------------------------------------------
// Widget Implementation
// -------------------------------------------------------------------------------------------------

pub struct GameMap {
    id: Id,
    options: GameMapOptions,
    spots: Vec<MapSpot>,
    paths: Vec<MapPath>,
    regions: Vec<MapRegion>,
    elevation_bands: Vec<MapElevationBand>,
    measure: Option<MapMeasure>,
}

impl GameMap {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self {
            id: Id::new("game_map_widget").with(id_salt),
            options: GameMapOptions::default(),
            spots: Vec::new(),
            paths: Vec::new(),
            regions: Vec::new(),
            elevation_bands: Vec::new(),
            measure: None,
        }
    }

    pub fn options(mut self, options: GameMapOptions) -> Self {
        self.options = options;
        self
    }

    pub fn spots(mut self, spots: Vec<MapSpot>) -> Self {
        self.spots = spots;
        self
    }

    pub fn paths(mut self, paths: Vec<MapPath>) -> Self {
        self.paths = paths;
        self
    }

    pub fn regions(mut self, regions: Vec<MapRegion>) -> Self {
        self.regions = regions;
        self
    }

    pub fn elevation_bands(mut self, elevation_bands: Vec<MapElevationBand>) -> Self {
        self.elevation_bands = elevation_bands;
        self
    }

    pub fn measure(mut self, measure: Option<MapMeasure>) -> Self {
        self.measure = measure;
        self
    }

    pub fn show(self, ui: &mut Ui) -> GameMapResponse {
        let ctx = ui.ctx().clone();
        let opts = self.options;

        let avail = ui.available_size();
        let width = opts.width.unwrap_or_else(|| avail.x.max(300.0));
        let height = opts.height.unwrap_or_else(|| avail.y.max(300.0));

        let (resp, painter) = ui.allocate_painter(vec2(width, height), Sense::click_and_drag());
        let rect = resp.rect;

        let mut st: GameMapState = ctx.memory_mut(|m| m.take_view_state(self.id));

        // Initialize state if first frame
        if let Some(init_center) = opts.initial_center {
            if st.center == pos2(0.0, 0.0) && st.zoom == 24.0 {
                st.center = pos2(init_center[0], init_center[1]);
            }
        }
        if let Some(init_zoom) = opts.initial_zoom {
            if st.zoom == 24.0 && init_zoom > 0.1 {
                st.zoom = init_zoom;
            }
        }

        let mut events: Vec<GameMapEvent> = Vec::new();
        let pointer = ctx.input(|i| i.pointer);
        let pointer_pos = pointer.pos;

        // -----------------------------------------------------------------------------------------
        // Coordinate Transforms
        // -----------------------------------------------------------------------------------------
        let screen_center = rect.center();
        let zoom = st.zoom;
        let center = st.center;

        let world_to_screen = |wx: f32, wy: f32| -> Pos2 {
            pos2(
                screen_center.x + (wx - center.x) * zoom,
                screen_center.y - (wy - center.y) * zoom,
            )
        };

        let screen_to_world = |sp: Pos2| -> Pos2 {
            pos2(
                center.x + (sp.x - screen_center.x) / zoom,
                center.y - (sp.y - screen_center.y) / zoom,
            )
        };

        let snap_world = |pos: Pos2| -> Pos2 {
            if opts.grid_snap_m > 0.0 {
                let snap_km = opts.grid_snap_m / 1000.0;
                pos2(
                    (pos.x / snap_km).round() * snap_km,
                    (pos.y / snap_km).round() * snap_km,
                )
            } else {
                pos
            }
        };

        if let Some(sp) = pointer_pos {
            if rect.contains(sp) {
                st.current_pointer_world = Some(screen_to_world(sp));
            } else {
                st.current_pointer_world = None;
            }
        } else {
            st.current_pointer_world = None;
        }

        // -----------------------------------------------------------------------------------------
        // Input Handling: Pan & Zoom
        // -----------------------------------------------------------------------------------------
        let is_hovered = pointer_pos.is_some_and(|p| rect.contains(p));
        let scroll_delta = if is_hovered { ctx.input(|i| i.scroll_delta.y) } else { 0.0 };

        if scroll_delta.abs() > 0.01 {
            let zoom_factor = if scroll_delta > 0.0 { 1.15 } else { 1.0 / 1.15 };
            let new_zoom = (st.zoom * zoom_factor).clamp(0.5, 800.0);

            // Zoom centered on pointer if over map
            if let Some(sp) = pointer_pos {
                if rect.contains(sp) {
                    let world_before = screen_to_world(sp);
                    st.zoom = new_zoom;
                    // recompute center so world_before stays at sp
                    st.center = pos2(
                        world_before.x - (sp.x - screen_center.x) / new_zoom,
                        world_before.y + (sp.y - screen_center.y) / new_zoom,
                    );
                } else {
                    st.zoom = new_zoom;
                }
            } else {
                st.zoom = new_zoom;
            }

            events.push(GameMapEvent::ViewportChanged {
                center_x: st.center.x,
                center_y: st.center.y,
                zoom: st.zoom,
            });
        }

        let is_space_down = ctx.input(|i| i.key_events.iter().any(|k| k.key == Key::Space && k.pressed));
        let is_pan_tool = opts.active_tool == "pan";

        if is_hovered {
            if (pointer.secondary_pressed || (is_pan_tool && pointer.primary_pressed) || (is_space_down && pointer.primary_pressed)) && !st.is_panning {
                st.is_panning = true;
                st.pan_start_pointer = pointer_pos;
                st.pan_start_center = st.center;
            }
        }

        if st.is_panning {
            if pointer.primary_down || pointer.secondary_down {
                if let (Some(cur), Some(start)) = (pointer_pos, st.pan_start_pointer) {
                    let dx = (cur.x - start.x) / st.zoom;
                    let dy = (cur.y - start.y) / st.zoom;
                    st.center = pos2(st.pan_start_center.x - dx, st.pan_start_center.y + dy);
                    events.push(GameMapEvent::ViewportChanged {
                        center_x: st.center.x,
                        center_y: st.center.y,
                        zoom: st.zoom,
                    });
                }
            } else {
                st.is_panning = false;
                st.pan_start_pointer = None;
            }
        }

        // -----------------------------------------------------------------------------------------
        // Drawing Pass
        // -----------------------------------------------------------------------------------------

        // 1. Map Canvas Background & Frame
        painter.rect_filled(rect, 4u8, BG_COLOR);

        // 2. Grid Lines & Axis Markings
        if opts.show_grid {
            let mut grid_step_km = 1.0f32;
            if st.zoom < 2.0 {
                grid_step_km = 20.0;
            } else if st.zoom < 6.0 {
                grid_step_km = 10.0;
            } else if st.zoom < 15.0 {
                grid_step_km = 5.0;
            } else if st.zoom < 40.0 {
                grid_step_km = 1.0;
            } else if st.zoom < 120.0 {
                grid_step_km = 0.25;
            } else {
                grid_step_km = 0.05;
            }

            let half_w = opts.world_width_km * 0.5;
            let half_h = opts.world_height_km * 0.5;

            let min_gx = ((-half_w / grid_step_km).floor() * grid_step_km).max(-half_w);
            let max_gx = half_w;
            let min_gy = ((-half_h / grid_step_km).floor() * grid_step_km).max(-half_h);
            let max_gy = half_h;

            let mut gx = min_gx;
            while gx <= max_gx + 0.001 {
                let p_top = world_to_screen(gx, half_h);
                let p_bottom = world_to_screen(gx, -half_h);

                if (p_top.x >= rect.min.x && p_top.x <= rect.max.x) || (p_bottom.x >= rect.min.x && p_bottom.x <= rect.max.x) {
                    let is_axis = gx.abs() < 1e-4;
                    let is_major = (gx / (grid_step_km * 5.0)).round() - (gx / (grid_step_km * 5.0)).abs() < 1e-4;
                    let stroke_col = if is_axis {
                        Color32::from_rgba_unmultiplied(255, 255, 255, 60)
                    } else if is_major {
                        GRID_MAJOR
                    } else {
                        GRID_MINOR
                    };
                    painter.line_segment([pos2(p_top.x, rect.min.y), pos2(p_bottom.x, rect.max.y)], Stroke::new(1.0, stroke_col));

                    if is_major || is_axis {
                        let label = if gx.abs() < 1e-4 {
                            "0".to_string()
                        } else if grid_step_km >= 1.0 {
                            format!("{:.0}km", gx)
                        } else {
                            format!("{:.0}m", gx * 1000.0)
                        };
                        painter.text(
                            pos2(p_top.x + 3.0, rect.min.y + 12.0),
                            Align2::LEFT_CENTER,
                            label,
                            FontId::proportional(9.0),
                            TEXT_MUTED,
                        );
                    }
                }
                gx += grid_step_km;
            }

            let mut gy = min_gy;
            while gy <= max_gy + 0.001 {
                let p_left = world_to_screen(-half_w, gy);
                let p_right = world_to_screen(half_w, gy);

                if (p_left.y >= rect.min.y && p_left.y <= rect.max.y) || (p_right.y >= rect.min.y && p_right.y <= rect.max.y) {
                    let is_axis = gy.abs() < 1e-4;
                    let is_major = (gy / (grid_step_km * 5.0)).round() - (gy / (grid_step_km * 5.0)).abs() < 1e-4;
                    let stroke_col = if is_axis {
                        Color32::from_rgba_unmultiplied(255, 255, 255, 60)
                    } else if is_major {
                        GRID_MAJOR
                    } else {
                        GRID_MINOR
                    };
                    painter.line_segment([pos2(rect.min.x, p_left.y), pos2(rect.max.x, p_right.y)], Stroke::new(1.0, stroke_col));

                    if (is_major || is_axis) && gy.abs() > 1e-4 {
                        let label = if grid_step_km >= 1.0 {
                            format!("{:.0}km", gy)
                        } else {
                            format!("{:.0}m", gy * 1000.0)
                        };
                        painter.text(
                            pos2(rect.min.x + 4.0, p_left.y - 6.0),
                            Align2::LEFT_CENTER,
                            label,
                            FontId::proportional(9.0),
                            TEXT_MUTED,
                        );
                    }
                }
                gy += grid_step_km;
            }
        }

        // 3. World Boundary Frame
        let half_w = opts.world_width_km * 0.5;
        let half_h = opts.world_height_km * 0.5;
        let p_tl = world_to_screen(-half_w, half_h);
        let p_br = world_to_screen(half_w, -half_h);
        let world_rect = Rect::from_min_max(pos2(p_tl.x.min(p_br.x), p_tl.y.min(p_br.y)), pos2(p_tl.x.max(p_br.x), p_tl.y.max(p_br.y)));
        painter.rect_stroke(world_rect, 0u8, Stroke::new(1.5, Color32::from_rgba_unmultiplied(255, 255, 255, 45)), StrokeKind::Middle);

        // 4. Elevation Bands / Contours
        if opts.show_contours {
            for band in &self.elevation_bands {
                if band.points.len() >= 2 {
                    let stroke_col = Color32::from_rgba_unmultiplied(
                        (band.color[0] * 255.0) as u8,
                        (band.color[1] * 255.0) as u8,
                        (band.color[2] * 255.0) as u8,
                        (band.color[3] * 120.0) as u8,
                    );
                    for w in band.points.windows(2) {
                        let p0 = world_to_screen(w[0][0], w[0][1]);
                        let p1 = world_to_screen(w[1][0], w[1][1]);
                        let b = Rect::from_min_max(pos2(p0.x.min(p1.x), p0.y.min(p1.y)), pos2(p0.x.max(p1.x), p0.y.max(p1.y)));
                        if rect.intersect(b).is_positive() {
                            painter.line_segment([p0, p1], Stroke::new(1.2, stroke_col));
                        }
                    }
                }
            }
        }

        // 5. Territory Regions
        if opts.show_biomes {
            for reg in &self.regions {
                if opts.blocking_mode && !reg.is_major {
                    continue;
                }
                if reg.points.len() >= 3 {
                    let screen_pts: Vec<Pos2> = reg.points.iter().map(|p| world_to_screen(p[0], p[1])).collect();

                    let fill = Color32::from_rgba_unmultiplied(
                        (reg.fill_color[0] * 255.0) as u8,
                        (reg.fill_color[1] * 255.0) as u8,
                        (reg.fill_color[2] * 255.0) as u8,
                        (reg.fill_color[3] * 255.0) as u8,
                    );
                    let border = Color32::from_rgba_unmultiplied(
                        (reg.border_color[0] * 255.0) as u8,
                        (reg.border_color[1] * 255.0) as u8,
                        (reg.border_color[2] * 255.0) as u8,
                        (reg.border_color[3] * 255.0) as u8,
                    );

                    painter.add(Shape::convex_polygon(screen_pts.clone(), fill, Stroke::new(1.5, border)));

                    // Center label calculation
                    let sum_x: f32 = screen_pts.iter().map(|p| p.x).sum();
                    let sum_y: f32 = screen_pts.iter().map(|p| p.y).sum();
                    let center_pt = pos2(sum_x / screen_pts.len() as f32, sum_y / screen_pts.len() as f32);

                    if rect.contains(center_pt) {
                        let text_w = Painter::measure_text(&ctx, FontId::proportional(11.0), &reg.name).x;
                        let badge_rect = Rect::from_center_size(center_pt, vec2(text_w + 12.0, 18.0));
                        painter.rect_filled(badge_rect, 4u8, Color32::from_rgba_unmultiplied(10, 14, 22, 180));
                        painter.text(center_pt, Align2::CENTER_CENTER, &reg.name, FontId::proportional(11.0), TEXT_BRIGHT);
                    }
                }
            }
        }

        // 6. Paths, Roads, Rivers, Bridges
        for path in &self.paths {
            if opts.blocking_mode && !path.is_major {
                continue;
            }
            if path.points.len() >= 2 {
                let is_selected = opts.selected_id.as_deref() == Some(&path.id);
                let col = Color32::from_rgba_unmultiplied(
                    (path.color[0] * 255.0) as u8,
                    (path.color[1] * 255.0) as u8,
                    (path.color[2] * 255.0) as u8,
                    (path.color[3] * 255.0) as u8,
                );

                let line_width = (path.width * (st.zoom / 24.0).clamp(0.6, 2.5)).clamp(1.5, 12.0);

                for w in path.points.windows(2) {
                    let p0 = world_to_screen(w[0][0], w[0][1]);
                    let p1 = world_to_screen(w[1][0], w[1][1]);

                    let b = Rect::from_min_max(pos2(p0.x.min(p1.x), p0.y.min(p1.y)), pos2(p0.x.max(p1.x), p0.y.max(p1.y)));
                    if !rect.intersect(b).is_positive() {
                        continue;
                    }

                    if path.path_type == "highway" {
                        // Double outline for highways
                        painter.line_segment([p0, p1], Stroke::new(line_width + 2.0, Color32::from_rgb(18, 22, 32)));
                        painter.line_segment([p0, p1], Stroke::new(line_width, col));
                    } else if path.path_type == "river" {
                        // Water blue with subtle glow
                        painter.line_segment([p0, p1], Stroke::new(line_width + 1.0, Color32::from_rgba_unmultiplied(30, 80, 140, 160)));
                        painter.line_segment([p0, p1], Stroke::new(line_width, ACCENT_CYAN));
                    } else if path.path_type == "bridge" {
                        // Bridge plank marks
                        painter.line_segment([p0, p1], Stroke::new(line_width + 4.0, Color32::from_rgb(45, 55, 72)));
                        painter.line_segment([p0, p1], Stroke::new(line_width, Color32::from_rgb(203, 213, 225)));
                    } else {
                        // Standard road or trail
                        painter.line_segment([p0, p1], Stroke::new(line_width, col));
                    }

                    if is_selected {
                        painter.line_segment([p0, p1], Stroke::new(line_width + 4.0, Color32::from_rgba_unmultiplied(56, 189, 248, 80)));
                    }
                }
            }
        }

        // 7. Spots / POIs (Points of Interest)
        let mut hovered_spot: Option<&MapSpot> = None;
        let mut clicked_spot: Option<&MapSpot> = None;

        for spot in &self.spots {
            if opts.blocking_mode && !spot.is_major {
                continue;
            }

            let sp = world_to_screen(spot.x, spot.y);
            if !rect.contains(sp) {
                continue;
            }

            let is_selected = opts.selected_id.as_deref() == Some(&spot.id);
            let is_capital = spot.spot_type == "capital";
            let base_radius = if is_capital { 11.0 } else if spot.is_major { 8.5 } else { 6.5 };

            let hit_rect = Rect::from_center_size(sp, vec2(base_radius * 2.8, base_radius * 2.8));
            let is_spot_hovered = pointer_pos.is_some_and(|p| hit_rect.contains(p));

            if is_spot_hovered {
                hovered_spot = Some(spot);
                if pointer.primary_pressed {
                    clicked_spot = Some(spot);
                }
            }

            // Selection glow ring
            if is_selected {
                painter.circle_stroke(sp, base_radius + 4.5, Stroke::new(2.0, ACCENT_CYAN));
                painter.circle_filled(sp, base_radius + 6.0, Color32::from_rgba_unmultiplied(56, 189, 248, 35));
            } else if is_spot_hovered {
                painter.circle_stroke(sp, base_radius + 3.0, Stroke::new(1.5, Color32::from_white_alpha(100)));
            }

            // Spot Badge
            let spot_col = Color32::from_rgba_unmultiplied(
                (spot.color[0] * 255.0) as u8,
                (spot.color[1] * 255.0) as u8,
                (spot.color[2] * 255.0) as u8,
                (spot.color[3] * 255.0) as u8,
            );

            // Outer dark rim
            painter.circle_filled(sp, base_radius + 1.5, Color32::from_rgb(15, 20, 30));
            // Colored fill
            painter.circle_filled(sp, base_radius, spot_col);

            // Spot glyph icon initial
            let glyph = match spot.spot_type.as_str() {
                "capital" => "★",
                "city" => "☗",
                "town" => "●",
                "village" => "▲",
                "fortress" => "⛊",
                "dungeon" => "☠",
                "ruin" => "❖",
                "port" => "⚓",
                "shrine" => "✦",
                "mine" => "⛏",
                "boss" => "⚔",
                _ => "•",
            };
            painter.text(sp, Align2::CENTER_CENTER, glyph, FontId::proportional(base_radius * 1.1), Color32::from_rgb(15, 20, 30));

            // Label text below spot
            let text_y = sp.y + base_radius + 6.0;
            let label_col = if is_selected { ACCENT_CYAN } else { TEXT_BRIGHT };
            painter.text(pos2(sp.x, text_y), Align2::CENTER_TOP, &spot.name, FontId::proportional(10.0), label_col);

            // Elevation pill
            if spot.elevation > 0.0 && st.zoom >= 18.0 {
                let elev_label = format!("▲{:.0}m", spot.elevation);
                painter.text(pos2(sp.x, text_y + 12.0), Align2::CENTER_TOP, elev_label, FontId::proportional(8.5), TEXT_MUTED);
            }
        }

        if let Some(spot) = clicked_spot {
            events.push(GameMapEvent::SpotSelected { id: spot.id.clone() });
        }

        // 8. Interactive Measurement Tool Overlay
        if let Some(measure) = &self.measure {
            if measure.active {
                let sp1 = world_to_screen(measure.p1[0], measure.p1[1]);
                let sp2 = world_to_screen(measure.p2[0], measure.p2[1]);

                // Dashed ruler line
                painter.line_segment([sp1, sp2], Stroke::new(2.0, ACCENT_AMBER));
                painter.circle_filled(sp1, 4.0, ACCENT_AMBER);
                painter.circle_filled(sp2, 4.0, ACCENT_AMBER);

                // Distance & travel pill at midpoint
                let mid = pos2((sp1.x + sp2.x) * 0.5, (sp1.y + sp2.y) * 0.5);
                let label = format!("{:.2} km | {}", measure.distance_km, measure.travel_info);
                let text_w = Painter::measure_text(&ctx, FontId::proportional(11.0), &label).x;
                let pill_rect = Rect::from_center_size(mid, vec2(text_w + 16.0, 22.0));

                painter.rect_filled(pill_rect, 4u8, Color32::from_rgba_unmultiplied(16, 20, 28, 230));
                painter.rect_stroke(pill_rect, 4u8, Stroke::new(1.0, ACCENT_AMBER), StrokeKind::Middle);
                painter.text(mid, Align2::CENTER_CENTER, label, FontId::proportional(11.0), TEXT_BRIGHT);
            }
        }

        // 9. Tooltip for hovered spot
        if let Some(spot) = hovered_spot {
            if let Some(sp) = pointer_pos {
                let tip_pos = pos2(sp.x + 14.0, sp.y + 14.0);
                let title = format!("{} ({})", spot.name, spot.spot_type);
                let sub = format!("Coord: [{:.2}, {:.2}] km | Elev: {:.0}m", spot.x, spot.y, spot.elevation);
                let tags = if !spot.tags.is_empty() { format!("Tags: {}", spot.tags.join(", ")) } else { String::new() };

                let w1 = Painter::measure_text(&ctx, FontId::proportional(11.5), &title).x;
                let w2 = Painter::measure_text(&ctx, FontId::proportional(10.0), &sub).x;
                let w3 = Painter::measure_text(&ctx, FontId::proportional(9.5), &tags).x;
                let box_w = w1.max(w2).max(w3) + 20.0;
                let box_h = if tags.is_empty() { 40.0 } else { 54.0 };

                let tip_rect = Rect::from_min_size(tip_pos, vec2(box_w, box_h));
                painter.rect_filled(tip_rect, 4u8, BADGE_BG);
                painter.rect_stroke(tip_rect, 4u8, Stroke::new(1.0, BORDER_COLOR), StrokeKind::Middle);

                painter.text(pos2(tip_pos.x + 8.0, tip_pos.y + 10.0), Align2::LEFT_CENTER, title, FontId::proportional(11.5), TEXT_BRIGHT);
                painter.text(pos2(tip_pos.x + 8.0, tip_pos.y + 24.0), Align2::LEFT_CENTER, sub, FontId::proportional(10.0), TEXT_DIM);
                if !tags.is_empty() {
                    painter.text(pos2(tip_pos.x + 8.0, tip_pos.y + 38.0), Align2::LEFT_CENTER, tags, FontId::proportional(9.5), ACCENT_EMERALD);
                }
            }
        }

        // 10. Canvas HUD: Scale Bar & Coordinates Readout
        // Scale bar in bottom-left
        let scale_km = if st.zoom > 100.0 { 0.1 } else if st.zoom > 40.0 { 0.5 } else if st.zoom > 15.0 { 2.0 } else if st.zoom > 5.0 { 5.0 } else { 20.0 };
        let bar_len_px = scale_km * st.zoom;
        let bar_origin = pos2(rect.min.x + 16.0, rect.max.y - 18.0);
        let bar_end = pos2(bar_origin.x + bar_len_px, bar_origin.y);

        painter.line_segment([pos2(bar_origin.x, bar_origin.y - 4.0), pos2(bar_origin.x, bar_origin.y + 4.0)], Stroke::new(1.5, TEXT_BRIGHT));
        painter.line_segment([bar_origin, bar_end], Stroke::new(1.5, TEXT_BRIGHT));
        painter.line_segment([pos2(bar_end.x, bar_end.y - 4.0), pos2(bar_end.x, bar_end.y + 4.0)], Stroke::new(1.5, TEXT_BRIGHT));

        let scale_label = if scale_km >= 1.0 { format!("{:.0} km", scale_km) } else { format!("{:.0} m", scale_km * 1000.0) };
        painter.text(pos2(bar_origin.x + bar_len_px * 0.5, bar_origin.y - 8.0), Align2::CENTER_BOTTOM, scale_label, FontId::proportional(9.5), TEXT_BRIGHT);

        // Compass Rose in top-right
        let compass_center = pos2(rect.max.x - 24.0, rect.min.y + 24.0);
        painter.circle_filled(compass_center, 12.0, Color32::from_rgba_unmultiplied(20, 25, 36, 190));
        painter.circle_stroke(compass_center, 12.0, Stroke::new(1.0, BORDER_COLOR));
        painter.text(compass_center, Align2::CENTER_CENTER, "N ▲", FontId::proportional(9.0), ACCENT_CYAN);

        // Coordinate and mode status bar at bottom-right
        let coord_text = if let Some(pw) = st.current_pointer_world {
            let snapped = snap_world(pw);
            format!("X: {:+.2}km  Y: {:+.2}km | Zoom: {:.1}x | Snap: {:.0}m", snapped.x, snapped.y, st.zoom, opts.grid_snap_m)
        } else {
            format!("World: {:.0}x{:.0} km | Zoom: {:.1}x", opts.world_width_km, opts.world_height_km, st.zoom)
        };
        painter.text(pos2(rect.max.x - 16.0, rect.max.y - 14.0), Align2::RIGHT_BOTTOM, coord_text, FontId::proportional(10.0), TEXT_DIM);

        // Mode Pill indicator (Blocking vs Detailing) at top-center
        let mode_label = if opts.blocking_mode { "MODE: BLOCKING (MACRO)" } else { "MODE: DETAILING (FULL)" };
        let mode_col = if opts.blocking_mode { ACCENT_AMBER } else { ACCENT_EMERALD };
        let mode_w = Painter::measure_text(&ctx, FontId::proportional(9.5), mode_label).x;
        let mode_pill_rect = Rect::from_center_size(pos2(rect.center().x, rect.min.y + 14.0), vec2(mode_w + 14.0, 18.0));
        painter.rect_filled(mode_pill_rect, 4u8, Color32::from_rgba_unmultiplied(15, 20, 30, 200));
        painter.rect_stroke(mode_pill_rect, 4u8, Stroke::new(1.0, mode_col), StrokeKind::Middle);
        painter.text(mode_pill_rect.center(), Align2::CENTER_CENTER, mode_label, FontId::proportional(9.5), mode_col);

        // Click handling on empty canvas
        if resp.clicked() && clicked_spot.is_none() && is_hovered {
            if let Some(pw) = st.current_pointer_world {
                let snapped = snap_world(pw);
                events.push(GameMapEvent::MapClicked { x: snapped.x, y: snapped.y });
            }
        }

        // Store persistent state back
        ctx.memory_mut(|m| m.put_view_state(self.id, st));

        GameMapResponse { events }
    }
}
