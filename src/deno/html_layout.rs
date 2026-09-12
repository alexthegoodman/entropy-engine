//! The HTML-as-UI experiment's layout engine. Parses HTML + CSS (`html_css.rs`), builds a
//! `taffy` tree (Block layout by default, Flex opt-in via `display: flex`, matching real CSS
//! defaults), computes it, and flattens the result into a flat list of absolutely-positioned
//! `LayoutBox`es that `addon_engine.rs`'s `UiWidget::LayoutCanvas` arm paints in one pass -
//! background/border/text via the raw painter, and buttons/checkboxes/inputs/hyperlinks/
//! dropdowns via `ui.child_ui_at(rect, ...)` so they get entropy_gui's real, already-correct
//! widget behavior (click, focus, typing, popups) for free, just placed at a taffy-computed
//! rect instead of flowing in the normal widget list.
//!
//! What this is NOT: a browser layout engine. Text never wraps (each text run is one
//! non-reflowing line, sized by a fixed average-character-width estimate, not real font
//! metrics - `op_ui_render_html` runs before any per-window `entropy_gui::Context` exists, so
//! there's nothing to measure glyphs against). No specificity-aware cascade (see html_css.rs).
//! No position/float/overflow/grid/transforms/pseudo-classes/media queries. Every `<img>` is a
//! real fetched-and-decoded bitmap (see `fetch_and_cache_image`) except when it fails or has no
//! resolvable URL, when it falls back to a `[image: alt]` text placeholder like before.
//!
//! Security boundary (deliberate, and load-bearing if this ever grows): nothing in this module
//! ever executes fetched content as code. `<script>` tags are skipped outright - their text is
//! never read, let alone run through a JS engine - and `<style>` is parsed as inert text data,
//! never evaluated. If a future session ever adds real `<script>` execution against a remote
//! page, that JS must run with CLI access, filesystem access, and multithreading all denied by
//! default and gated behind explicit user consent (a real prompt, not a config flag) before any
//! of the three is granted - a compromised or malicious site's script must not be able to touch
//! the host system just because the user browsed to it. Nothing here needs that gate yet because
//! nothing here executes anything; keep it that way until that consent mechanism actually exists.

use crate::deno::html_css::{self, ComputedStyle, DisplayMode, FlexDir, Justify, AlignI, Len, TextAlign};
use ego_tree::{NodeId, NodeRef};
use scraper::{Html, Node};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind")]
pub enum LayoutLeaf {
    Text { text: String, bold: bool, color: Option<[f32; 4]>, align: u8 },
    Button { id: String, text: String },
    Checkbox { id: String, value: bool },
    TextInput { id: String, value: String },
    Hyperlink { id: String, text: String, url: String },
    Dropdown { id: String, options: Vec<String>, selected_index: usize },
    Image { texture_id: String },
    ImagePlaceholder { text: String },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LayoutBox {
    pub id_salt: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub background: Option<[f32; 4]>,
    pub border: Option<([f32; 4], f32)>,
    pub leaf: Option<LayoutLeaf>,
}

const SKIP_TAGS: &[&str] = &["script", "style", "head", "noscript", "template", "svg", "meta", "link", "iframe", "object", "canvas"];
const LEAF_TAGS: &[&str] = &["button", "input", "textarea", "select", "img", "br", "hr", "li", "tr", "a"];

const DEFAULT_VIEWPORT_WIDTH: f32 = 760.0;
const TEXT_LINE_HEIGHT: f32 = 20.0;
const AVG_CHAR_WIDTH: f32 = 7.2;

fn estimate_text_size(text: &str, bold: bool) -> (f32, f32) {
    let w = text.chars().count() as f32 * AVG_CHAR_WIDTH * if bold { 1.08 } else { 1.0 };
    (w.max(4.0), TEXT_LINE_HEIGHT)
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn attr<'a>(node: NodeRef<'a, Node>, name: &str) -> Option<&'a str> {
    match node.value() {
        Node::Element(el) => el.attr(name),
        _ => None,
    }
}

fn tag_name<'a>(node: NodeRef<'a, Node>) -> Option<&'a str> {
    match node.value() {
        Node::Element(el) => Some(el.name()),
        _ => None,
    }
}

fn text_content(node: NodeRef<'_, Node>) -> String {
    let mut buf = String::new();
    for d in node.descendants() {
        if let Node::Text(t) = d.value() {
            if !buf.is_empty() && !buf.ends_with(' ') {
                buf.push(' ');
            }
            buf.push_str(t);
        }
    }
    normalize_ws(&buf)
}

fn resolve_url(base: &Option<url::Url>, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') || href.starts_with("javascript:") {
        return None;
    }
    if let Ok(u) = url::Url::parse(href) {
        return Some(u.to_string());
    }
    base.as_ref().and_then(|b| b.join(href).ok()).map(|u| u.to_string())
}

/// Fetches and decodes `url`, uploads it as a wgpu texture cached by URL (so re-rendering the
/// same page every frame doesn't re-fetch), and returns (texture_id, width, height). `ctx` is
/// the engine's `AddonContext` - this must run inside the same op call that owns it
/// (`op_ui_render_html`), before any egui-side texture registration happens at render time.
fn fetch_and_cache_image(ctx: &mut crate::deno::addon_ops::AddonContext, url: &str) -> Option<(String, f32, f32)> {
    if let Some(&(w, h)) = ctx.html_image_dims.get(url) {
        return Some((html_image_texture_id(url), w as f32, h as f32));
    }
    if ctx.html_image_failed.contains(url) {
        return None;
    }

    let bytes = match crate::deno::net::blocking_fetch_bytes(url) {
        Ok(b) => b,
        Err(_) => {
            ctx.html_image_failed.insert(url.to_string());
            return None;
        }
    };
    let decoded = match image::load_from_memory(&bytes) {
        Ok(i) => i.to_rgba8(),
        Err(_) => {
            ctx.html_image_failed.insert(url.to_string());
            return None;
        }
    };
    let (w, h) = decoded.dimensions();
    // "Basics" safety valve, not a real memory budget - just avoids a pathological huge image
    // blowing up GPU allocation from a single <img> tag.
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        ctx.html_image_failed.insert(url.to_string());
        return None;
    }

    let Some(gpu) = ctx.gpu_resources.clone() else {
        return None;
    };
    let texture_id = html_image_texture_id(url);
    let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("HTML <img>"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        &decoded,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * w), rows_per_image: None },
        size,
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    ctx.textures.insert(texture_id.clone(), std::sync::Arc::new(view));
    ctx.raw_textures.insert(texture_id.clone(), std::sync::Arc::new(texture));
    ctx.html_image_dims.insert(url.to_string(), (w, h));
    Some((texture_id, w as f32, h as f32))
}

fn html_image_texture_id(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    format!("html_img_{:x}", hasher.finish())
}

struct Builder<'a> {
    tree: taffy::TaffyTree<()>,
    meta: HashMap<taffy::NodeId, LayoutBox>,
    styles: HashMap<NodeId, ComputedStyle>,
    base_url: Option<url::Url>,
    ctx: &'a mut crate::deno::addon_ops::AddonContext,
    counter: usize,
}

impl<'a> Builder<'a> {
    fn salt(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("html_{}_{}", prefix, self.counter)
    }

    fn leaf(&mut self, w: f32, h: f32, background: Option<[f32; 4]>, border: Option<([f32; 4], f32)>, leaf: LayoutLeaf, id_salt: String) -> taffy::NodeId {
        let style = taffy::Style {
            display: taffy::Display::Block,
            size: taffy::Size { width: taffy::Dimension::length(w), height: taffy::Dimension::length(h) },
            ..Default::default()
        };
        let node = self.tree.new_leaf(style).unwrap();
        self.meta.insert(node, LayoutBox { id_salt, x: 0.0, y: 0.0, w, h, background, border, leaf: Some(leaf) });
        node
    }

    fn text_leaf(&mut self, text: String, color: Option<[f32; 4]>, bold: bool, align: u8) -> taffy::NodeId {
        let (w, h) = estimate_text_size(&text, bold);
        let salt = self.salt("text");
        self.leaf(w, h, None, None, LayoutLeaf::Text { text, bold, color, align }, salt)
    }

    fn container(&mut self, style: &ComputedStyle, children: Vec<taffy::NodeId>) -> taffy::NodeId {
        let taffy_style = to_taffy_style(style);
        let node = self.tree.new_with_children(taffy_style, &children).unwrap();
        let salt = self.salt("box");
        self.meta.insert(node, LayoutBox { id_salt: salt, x: 0.0, y: 0.0, w: 0.0, h: 0.0, background: style.background, border: style.border, leaf: None });
        node
    }
}

fn to_taffy_style(style: &ComputedStyle) -> taffy::Style {
    let mut s = taffy::Style::default();
    s.display = match style.display {
        Some(DisplayMode::None) => taffy::Display::None,
        Some(DisplayMode::Flex) => taffy::Display::Flex,
        _ => taffy::Display::Block,
    };
    if let Some(FlexDir::Column) = style.flex_direction {
        s.flex_direction = taffy::FlexDirection::Column;
    }
    if let Some(j) = style.justify_content {
        s.justify_content = Some(match j {
            Justify::Center => taffy::JustifyContent::CENTER,
            Justify::End => taffy::JustifyContent::END,
            Justify::SpaceBetween => taffy::JustifyContent::SPACE_BETWEEN,
            Justify::SpaceAround => taffy::JustifyContent::SPACE_AROUND,
            Justify::Start => taffy::JustifyContent::START,
        });
    }
    if let Some(a) = style.align_items {
        s.align_items = Some(match a {
            AlignI::Center => taffy::AlignItems::CENTER,
            AlignI::End => taffy::AlignItems::END,
            AlignI::Stretch => taffy::AlignItems::STRETCH,
            AlignI::Start => taffy::AlignItems::START,
        });
    }
    if let Some(gap) = style.gap {
        s.gap = taffy::Size { width: taffy::LengthPercentage::length(gap), height: taffy::LengthPercentage::length(gap) };
    }
    if let Some(w) = style.width {
        s.size.width = len_to_dimension(w);
    }
    if let Some(h) = style.height {
        s.size.height = len_to_dimension(h);
    }
    s.margin = taffy::Rect {
        top: style.margin[0].map(len_to_lpa).unwrap_or(taffy::LengthPercentageAuto::length(0.0)),
        right: style.margin[1].map(len_to_lpa).unwrap_or(taffy::LengthPercentageAuto::length(0.0)),
        bottom: style.margin[2].map(len_to_lpa).unwrap_or(taffy::LengthPercentageAuto::length(0.0)),
        left: style.margin[3].map(len_to_lpa).unwrap_or(taffy::LengthPercentageAuto::length(0.0)),
    };
    s.padding = taffy::Rect {
        top: style.padding[0].map(len_to_lp).unwrap_or(taffy::LengthPercentage::length(0.0)),
        right: style.padding[1].map(len_to_lp).unwrap_or(taffy::LengthPercentage::length(0.0)),
        bottom: style.padding[2].map(len_to_lp).unwrap_or(taffy::LengthPercentage::length(0.0)),
        left: style.padding[3].map(len_to_lp).unwrap_or(taffy::LengthPercentage::length(0.0)),
    };
    if let Some((_, width)) = style.border {
        s.border = taffy::Rect {
            top: taffy::LengthPercentage::length(width),
            right: taffy::LengthPercentage::length(width),
            bottom: taffy::LengthPercentage::length(width),
            left: taffy::LengthPercentage::length(width),
        };
    }
    s
}

fn len_to_dimension(l: Len) -> taffy::Dimension {
    match l {
        Len::Px(px) => taffy::Dimension::length(px),
        Len::Pct(p) => taffy::Dimension::percent(p),
        Len::Auto => taffy::Dimension::auto(),
    }
}
fn len_to_lpa(l: Len) -> taffy::LengthPercentageAuto {
    match l {
        Len::Px(px) => taffy::LengthPercentageAuto::length(px),
        Len::Pct(p) => taffy::LengthPercentageAuto::percent(p),
        Len::Auto => taffy::LengthPercentageAuto::auto(),
    }
}
fn len_to_lp(l: Len) -> taffy::LengthPercentage {
    match l {
        Len::Px(px) => taffy::LengthPercentage::length(px),
        Len::Pct(p) => taffy::LengthPercentage::percent(p),
        Len::Auto => taffy::LengthPercentage::length(0.0),
    }
}

/// `color`, `font-weight` and `text-align` are real CSS inherited properties - a `<p>` with no
/// `color` of its own takes its parent's, all the way up to the root. `background`/`border` are
/// deliberately NOT inherited (matching spec - each box paints only its own), but `ancestor_bg`
/// still tracks the nearest ancestor background anyway, purely as an input to
/// `default_text_color_for_bg`'s contrast heuristic below - real browsers don't need this
/// because they always have a real default text color (black); this UI's default text color is
/// the app's own theme color (fine against the app's own dark chrome, wrong against a page that
/// sets a light background but never sets `color`, like the actual example.com does).
#[derive(Clone, Default)]
struct Inherited {
    color: Option<[f32; 4]>,
    bold: Option<bool>,
    text_align: Option<TextAlign>,
    ancestor_bg: Option<[f32; 4]>,
}

fn default_text_color_for_bg(bg: Option<[f32; 4]>) -> Option<[f32; 4]> {
    let bg = bg?;
    let luminance = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    Some(if luminance > 0.5 { [0.05, 0.05, 0.05, 1.0] } else { [0.95, 0.95, 0.95, 1.0] })
}

fn align_code(align: Option<TextAlign>) -> u8 {
    match align {
        Some(TextAlign::Center) => 1,
        Some(TextAlign::Right) => 2,
        _ => 0,
    }
}

fn build_node(node: NodeRef<'_, Node>, b: &mut Builder, inherited: &Inherited) -> Option<taffy::NodeId> {
    match node.value() {
        Node::Text(text) => {
            let s = normalize_ws(text);
            if s.is_empty() {
                return None;
            }
            let color = inherited.color.or_else(|| default_text_color_for_bg(inherited.ancestor_bg));
            Some(b.text_leaf(s, color, inherited.bold.unwrap_or(false), align_code(inherited.text_align)))
        }
        Node::Element(el) => {
            let tag = el.name();
            if SKIP_TAGS.contains(&tag) {
                // `<script>` content is never read here, let alone executed - see this
                // module's top doc comment for why that boundary matters.
                return None;
            }
            let style = b.styles.get(&node.id()).cloned().unwrap_or_default();
            if style.display == Some(DisplayMode::None) {
                return None;
            }

            let is_heading = matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
            let ancestor_bg = style.background.or(inherited.ancestor_bg);
            let child_inherited = Inherited {
                color: style.color.or(inherited.color),
                bold: style.bold.or(inherited.bold).or(if is_heading { Some(true) } else { None }),
                text_align: style.text_align.or(inherited.text_align),
                ancestor_bg,
            };

            if LEAF_TAGS.contains(&tag) {
                return build_leaf_element(node, tag, &style, b, &child_inherited);
            }

            let resolved_color = child_inherited.color.or_else(|| default_text_color_for_bg(ancestor_bg));
            let resolved_align = align_code(child_inherited.text_align);
            let mut children = Vec::new();
            let mut text_buf = String::new();
            for child in node.children() {
                if let Node::Text(t) = child.value() {
                    let frag = normalize_ws(t);
                    if !frag.is_empty() {
                        if !text_buf.is_empty() {
                            text_buf.push(' ');
                        }
                        text_buf.push_str(&frag);
                    }
                } else {
                    if !text_buf.trim().is_empty() {
                        children.push(b.text_leaf(text_buf.trim().to_string(), resolved_color, child_inherited.bold.unwrap_or(false), resolved_align));
                    }
                    text_buf.clear();
                    if let Some(child_id) = build_node(child, b, &child_inherited) {
                        children.push(child_id);
                    }
                }
            }
            if !text_buf.trim().is_empty() {
                children.push(b.text_leaf(text_buf.trim().to_string(), resolved_color, child_inherited.bold.unwrap_or(false), resolved_align));
            }
            if children.is_empty() {
                return None;
            }
            Some(b.container(&style, children))
        }
        _ => {
            let mut children = Vec::new();
            for child in node.children() {
                if let Some(id) = build_node(child, b, inherited) {
                    children.push(id);
                }
            }
            if children.is_empty() {
                None
            } else {
                Some(b.container(&ComputedStyle::default(), children))
            }
        }
    }
}

fn build_leaf_element(node: NodeRef<'_, Node>, tag: &str, style: &ComputedStyle, b: &mut Builder, inherited: &Inherited) -> Option<taffy::NodeId> {
    match tag {
        "br" => None,
        "hr" => {
            // Width is left `auto` (not a fixed pixel leaf) so Block layout stretches it to
            // fill the parent's content width, matching a real `<hr>`'s default 100% width.
            let taffy_style = taffy::Style {
                display: taffy::Display::Block,
                size: taffy::Size { width: taffy::Dimension::auto(), height: taffy::Dimension::length(2.0) },
                ..Default::default()
            };
            let node = b.tree.new_leaf(taffy_style).unwrap();
            let salt = b.salt("hr");
            b.meta.insert(node, LayoutBox { id_salt: salt, x: 0.0, y: 0.0, w: 0.0, h: 0.0, background: style.background.or(Some([0.5, 0.5, 0.5, 1.0])), border: None, leaf: None });
            Some(node)
        }
        "img" => {
            let src = attr(node, "src").unwrap_or("");
            let resolved = resolve_url(&b.base_url, src);
            if let Some(url) = resolved.as_ref().and_then(|u| fetch_and_cache_image(b.ctx, u)) {
                let (texture_id, iw, ih) = url;
                let max_w = style.width.and_then(|l| if let Len::Px(px) = l { Some(px) } else { None }).unwrap_or(DEFAULT_VIEWPORT_WIDTH);
                let (w, h) = if iw > max_w { (max_w, ih * (max_w / iw)) } else { (iw, ih) };
                let salt = b.salt("img");
                Some(b.leaf(w, h, None, None, LayoutLeaf::Image { texture_id }, salt))
            } else {
                let alt = attr(node, "alt").filter(|s| !s.is_empty()).unwrap_or(src);
                let text = format!("[image: {}]", alt);
                let (w, h) = estimate_text_size(&text, false);
                let salt = b.salt("imgph");
                Some(b.leaf(w, h, None, None, LayoutLeaf::ImagePlaceholder { text }, salt))
            }
        }
        "a" => {
            let text = text_content(node);
            if text.is_empty() {
                return None;
            }
            let href = attr(node, "href").unwrap_or("#");
            let url = resolve_url(&b.base_url, href).unwrap_or_else(|| href.to_string());
            let (w, h) = estimate_text_size(&text, false);
            let salt = b.salt("a");
            let id = salt.clone();
            Some(b.leaf(w, h, None, None, LayoutLeaf::Hyperlink { id, text, url }, salt))
        }
        "button" => {
            let text = {
                let t = text_content(node);
                if t.is_empty() { attr(node, "value").unwrap_or("Button").to_string() } else { t }
            };
            let (tw, th) = estimate_text_size(&text, false);
            let salt = b.salt("button");
            let id = salt.clone();
            Some(b.leaf(tw + 24.0, th + 12.0, None, None, LayoutLeaf::Button { id, text }, salt))
        }
        "input" => {
            let input_type = attr(node, "type").unwrap_or("text");
            let salt = b.salt("input");
            let id = salt.clone();
            match input_type {
                "hidden" => None,
                "checkbox" | "radio" => {
                    let value = attr(node, "checked").is_some();
                    Some(b.leaf(20.0, 20.0, None, None, LayoutLeaf::Checkbox { id, value }, salt))
                }
                "button" | "submit" | "reset" => {
                    let text = attr(node, "value").unwrap_or("Submit").to_string();
                    let (tw, th) = estimate_text_size(&text, false);
                    Some(b.leaf(tw + 24.0, th + 12.0, None, None, LayoutLeaf::Button { id, text }, salt))
                }
                _ => {
                    let value = attr(node, "value").unwrap_or("").to_string();
                    Some(b.leaf(180.0, 32.0, None, None, LayoutLeaf::TextInput { id, value }, salt))
                }
            }
        }
        "textarea" => {
            let value = text_content(node);
            let salt = b.salt("textarea");
            let id = salt.clone();
            Some(b.leaf(300.0, 80.0, None, None, LayoutLeaf::TextInput { id, value }, salt))
        }
        "select" => {
            let mut options = Vec::new();
            let mut selected_index = 0usize;
            for child in node.children() {
                if tag_name(child) == Some("option") {
                    if attr(child, "selected").is_some() {
                        selected_index = options.len();
                    }
                    options.push(text_content(child));
                }
            }
            if options.is_empty() {
                options.push(String::new());
            }
            let salt = b.salt("select");
            let id = salt.clone();
            Some(b.leaf(160.0, 32.0, None, None, LayoutLeaf::Dropdown { id, options, selected_index }, salt))
        }
        "li" => {
            let text = format!("\u{2022} {}", text_content(node));
            let color = inherited.color.or_else(|| default_text_color_for_bg(inherited.ancestor_bg));
            Some(b.text_leaf(text, color, inherited.bold.unwrap_or(false), align_code(inherited.text_align)))
        }
        "tr" => {
            let mut cells = Vec::new();
            for child in node.children() {
                if matches!(tag_name(child), Some("td") | Some("th")) {
                    let t = text_content(child);
                    if !t.is_empty() {
                        cells.push(t);
                    }
                }
            }
            if cells.is_empty() {
                None
            } else {
                let color = inherited.color.or_else(|| default_text_color_for_bg(inherited.ancestor_bg));
                Some(b.text_leaf(cells.join("  |  "), color, inherited.bold.unwrap_or(false), align_code(inherited.text_align)))
            }
        }
        _ => None,
    }
}

/// Parses `html`, resolves CSS, lays it out with `taffy` at `viewport_width` (auto-height), and
/// returns `(total_width, total_height, boxes)` ready to become a `UiWidget::LayoutCanvas`.
/// `base_url`, when given, resolves relative `<img src>`/`<a href>` - pass the fetched page's
/// own URL for real webpages; omit it for hand-authored addon markup that has none.
pub fn build(html: &str, base_url: Option<&str>, viewport_width: f32, ctx: &mut crate::deno::addon_ops::AddonContext) -> (f32, f32, Vec<LayoutBox>) {
    let document = Html::parse_document(html);
    let styles = html_css::resolve_styles(&document);
    let base_url = base_url.and_then(|u| url::Url::parse(u).ok());
    let viewport_width = if viewport_width > 0.0 { viewport_width } else { DEFAULT_VIEWPORT_WIDTH };

    let mut builder = Builder { tree: taffy::TaffyTree::new(), meta: HashMap::new(), styles, base_url, ctx, counter: 0 };
    let Some(root) = build_node(document.tree.root(), &mut builder, &Inherited::default()) else {
        return (viewport_width, 0.0, Vec::new());
    };

    let available = taffy::Size { width: taffy::AvailableSpace::Definite(viewport_width), height: taffy::AvailableSpace::MaxContent };
    if builder.tree.compute_layout(root, available).is_err() {
        return (viewport_width, 0.0, Vec::new());
    }

    let mut boxes = Vec::new();
    flatten(&builder.tree, root, 0.0, 0.0, &builder.meta, &mut boxes);
    let root_layout = builder.tree.layout(root).unwrap();
    (root_layout.size.width, root_layout.size.height, boxes)
}

fn flatten(tree: &taffy::TaffyTree<()>, node: taffy::NodeId, parent_x: f32, parent_y: f32, meta: &HashMap<taffy::NodeId, LayoutBox>, out: &mut Vec<LayoutBox>) {
    let Ok(layout) = tree.layout(node) else { return };
    let x = parent_x + layout.location.x;
    let y = parent_y + layout.location.y;

    if let Some(m) = meta.get(&node) {
        let mut b = m.clone();
        b.x = x;
        b.y = y;
        b.w = layout.size.width;
        b.h = layout.size.height;
        out.push(b);
    }
    if let Ok(children) = tree.children(node) {
        for child in children {
            flatten(tree, child, x, y, meta, out);
        }
    }
}
