//! A deliberately small CSS engine backing the HTML-as-UI experiment (`html_layout.rs`) - just
//! enough to cover the basics taffy's Block/Flex layout needs, not a spec-compliant cascade.
//! Selector matching itself is real (delegated to `scraper`/`selectors`, the actual Servo
//! selector engine) so `.card > p:first-child` and friends work; what's simplified is the
//! cascade (source order only - no specificity scoring, inline `style=` always wins last) and
//! the property set (see `apply_declaration` for the full supported list). No pseudo-classes
//! with runtime state (`:hover`, `:focus`), no media queries, no animations/transitions, no
//! `position`/`float`/`overflow`/`grid`/`transform` - all explicitly out of scope for "basics".

use ego_tree::NodeId;
use scraper::{Html, Selector};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Len {
    Px(f32),
    Pct(f32),
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DisplayMode {
    Block,
    Flex,
    None,
    Inline,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FlexDir {
    Row,
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Justify {
    Start,
    Center,
    End,
    SpaceBetween,
    SpaceAround,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AlignI {
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, Default)]
pub struct ComputedStyle {
    pub display: Option<DisplayMode>,
    pub flex_direction: Option<FlexDir>,
    pub justify_content: Option<Justify>,
    pub align_items: Option<AlignI>,
    pub gap: Option<f32>,
    pub width: Option<Len>,
    pub height: Option<Len>,
    /// [top, right, bottom, left]
    pub margin: [Option<Len>; 4],
    pub padding: [Option<Len>; 4],
    pub background: Option<[f32; 4]>,
    pub color: Option<[f32; 4]>,
    pub bold: Option<bool>,
    pub text_align: Option<TextAlign>,
    /// (color, width_px)
    pub border: Option<([f32; 4], f32)>,
}

struct StyleRule {
    selector: Selector,
    decls: Vec<(String, String)>,
}

/// Resolves every element's `ComputedStyle` by parsing `<style>` blocks + inline `style=`
/// attributes and matching selectors against the whole document. Called once per
/// `html_layout::build` call (i.e. once per `Entropy.UI.Widget.html()` call - see that
/// function's doc comment for why this isn't cached across frames).
pub fn resolve_styles(document: &Html) -> HashMap<NodeId, ComputedStyle> {
    let style_selector = Selector::parse("style").unwrap();
    let mut css_text = String::new();
    for el in document.select(&style_selector) {
        css_text.push_str(&el.text().collect::<Vec<_>>().join(""));
        css_text.push('\n');
    }
    let rules = parse_stylesheet(&css_text);

    let mut per_node_decls: HashMap<NodeId, Vec<(String, String)>> = HashMap::new();
    for rule in &rules {
        for el in document.select(&rule.selector) {
            per_node_decls.entry(el.id()).or_default().extend(rule.decls.iter().cloned());
        }
    }

    let all_selector = Selector::parse("*").unwrap();
    for el in document.select(&all_selector) {
        if let Some(style_attr) = el.value().attr("style") {
            let decls = parse_declarations(style_attr);
            if !decls.is_empty() {
                per_node_decls.entry(el.id()).or_default().extend(decls);
            }
        }
    }

    let mut computed = HashMap::new();
    for (node_id, decls) in per_node_decls {
        let mut style = ComputedStyle::default();
        for (prop, value) in decls {
            apply_declaration(&mut style, &prop, &value);
        }
        computed.insert(node_id, style);
    }
    computed
}

/// Splits a `<style>` block's text into rules. Simple brace-depth-1 scanning (no nested
/// `@media`/`@supports` support - an `@`-prefixed selector is just skipped) rather than a real
/// CSS tokenizer, since we don't need to survive anything fancier than "basics".
fn parse_stylesheet(css: &str) -> Vec<StyleRule> {
    let css = strip_css_comments(css);
    let mut rules = Vec::new();
    let mut i = 0usize;
    while i < css.len() {
        let Some(open_rel) = css[i..].find('{') else { break };
        let selector_text = css[i..i + open_rel].trim();
        let body_start = i + open_rel + 1;
        let Some(close_rel) = css[body_start..].find('}') else { break };
        let body = &css[body_start..body_start + close_rel];

        if !selector_text.is_empty() && !selector_text.starts_with('@') {
            let decls = parse_declarations(body);
            for sel_part in selector_text.split(',') {
                let sel_part = sel_part.trim();
                if sel_part.is_empty() {
                    continue;
                }
                if let Ok(selector) = Selector::parse(sel_part) {
                    rules.push(StyleRule { selector, decls: decls.clone() });
                }
            }
        }
        i = body_start + close_rel + 1;
    }
    rules
}

fn strip_css_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            while let Some(c2) = chars.next() {
                if c2 == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parses a declaration list ("prop: value; prop2: value2"), respecting paren depth so values
/// like `rgba(0,0,0,.5)` or `url(http://...)` don't get split on their internal `:`/`,`.
pub fn parse_declarations(body: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for c in body.chars() {
        match c {
            '(' => {
                depth += 1;
                current.push(c);
            }
            ')' => {
                depth -= 1;
                current.push(c);
            }
            ';' if depth <= 0 => {
                push_decl(&mut out, &current);
                current.clear();
            }
            _ => current.push(c),
        }
    }
    push_decl(&mut out, &current);
    out
}

fn push_decl(out: &mut Vec<(String, String)>, raw: &str) {
    let Some(idx) = raw.find(':') else { return };
    let prop = raw[..idx].trim().to_ascii_lowercase();
    let mut value = raw[idx + 1..].trim().to_string();
    if let Some(pos) = value.to_ascii_lowercase().find("!important") {
        value = value[..pos].trim().to_string();
    }
    if !prop.is_empty() && !value.is_empty() {
        out.push((prop, value));
    }
}

pub fn apply_declaration(style: &mut ComputedStyle, prop: &str, value: &str) {
    let value = value.trim();
    match prop {
        "display" => {
            style.display = Some(match value {
                "none" => DisplayMode::None,
                "flex" | "inline-flex" => DisplayMode::Flex,
                "inline" | "inline-block" => DisplayMode::Inline,
                _ => DisplayMode::Block,
            });
        }
        "flex-direction" => {
            style.flex_direction = Some(if value == "column" || value == "column-reverse" { FlexDir::Column } else { FlexDir::Row });
        }
        "justify-content" => {
            style.justify_content = Some(match value {
                "center" => Justify::Center,
                "flex-end" | "end" => Justify::End,
                "space-between" => Justify::SpaceBetween,
                "space-around" | "space-evenly" => Justify::SpaceAround,
                _ => Justify::Start,
            });
        }
        "align-items" => {
            style.align_items = Some(match value {
                "center" => AlignI::Center,
                "flex-end" | "end" => AlignI::End,
                "stretch" => AlignI::Stretch,
                _ => AlignI::Start,
            });
        }
        "gap" | "row-gap" | "column-gap" => {
            if let Some(Len::Px(px)) = parse_len(value.split_whitespace().next().unwrap_or(value)) {
                style.gap = Some(px);
            }
        }
        "width" => style.width = parse_len(value),
        "height" => style.height = parse_len(value),
        "margin" => {
            if let Some(m) = parse_box_shorthand(value) {
                style.margin = m;
            }
        }
        "margin-top" => style.margin[0] = parse_len(value),
        "margin-right" => style.margin[1] = parse_len(value),
        "margin-bottom" => style.margin[2] = parse_len(value),
        "margin-left" => style.margin[3] = parse_len(value),
        "padding" => {
            if let Some(p) = parse_box_shorthand(value) {
                style.padding = p;
            }
        }
        "padding-top" => style.padding[0] = parse_len(value),
        "padding-right" => style.padding[1] = parse_len(value),
        "padding-bottom" => style.padding[2] = parse_len(value),
        "padding-left" => style.padding[3] = parse_len(value),
        "background" | "background-color" => {
            if let Some(c) = parse_color(value) {
                style.background = Some(c);
            }
        }
        "color" => {
            if let Some(c) = parse_color(value) {
                style.color = Some(c);
            }
        }
        "font-weight" => {
            style.bold = Some(value == "bold" || value == "bolder" || value.parse::<i32>().map(|n| n >= 600).unwrap_or(false));
        }
        "text-align" => {
            style.text_align = Some(match value {
                "center" => TextAlign::Center,
                "right" | "end" => TextAlign::Right,
                _ => TextAlign::Left,
            });
        }
        "border" => style.border = parse_border(value),
        _ => {}
    }
}

fn parse_box_shorthand(value: &str) -> Option<[Option<Len>; 4]> {
    let lens: Vec<Option<Len>> = value.split_whitespace().map(parse_len).collect();
    match lens.len() {
        1 => Some([lens[0], lens[0], lens[0], lens[0]]),
        2 => Some([lens[0], lens[1], lens[0], lens[1]]),
        3 => Some([lens[0], lens[1], lens[2], lens[1]]),
        4 => Some([lens[0], lens[1], lens[2], lens[3]]),
        _ => None,
    }
}

fn parse_len(s: &str) -> Option<Len> {
    let s = s.trim();
    if s.eq_ignore_ascii_case("auto") {
        return Some(Len::Auto);
    }
    if let Some(pct) = s.strip_suffix('%') {
        return pct.trim().parse::<f32>().ok().map(|v| Len::Pct(v / 100.0));
    }
    if let Some(px) = s.strip_suffix("px") {
        return px.trim().parse::<f32>().ok().map(Len::Px);
    }
    // em/rem have no real font-size cascade here (see html_layout's fixed text metrics) - 16px
    // is just the common browser default, an approximation like everything else "basics".
    if let Some(rem) = s.strip_suffix("rem") {
        return rem.trim().parse::<f32>().ok().map(|v| Len::Px(v * 16.0));
    }
    if let Some(em) = s.strip_suffix("em") {
        return em.trim().parse::<f32>().ok().map(|v| Len::Px(v * 16.0));
    }
    s.parse::<f32>().ok().map(Len::Px)
}

pub fn parse_color(s: &str) -> Option<[f32; 4]> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        return parse_hex_color(hex);
    }
    if let Some(inner) = s.strip_prefix("rgba(").and_then(|v| v.strip_suffix(')')) {
        return parse_rgb_components(inner);
    }
    if let Some(inner) = s.strip_prefix("rgb(").and_then(|v| v.strip_suffix(')')) {
        return parse_rgb_components(inner);
    }
    named_color(s)
}

fn parse_rgb_components(inner: &str) -> Option<[f32; 4]> {
    let parts: Vec<f32> = inner.split(',').filter_map(|p| p.trim().parse::<f32>().ok()).collect();
    if parts.len() < 3 {
        return None;
    }
    let a = if parts.len() >= 4 { parts[3] } else { 1.0 };
    Some([parts[0] / 255.0, parts[1] / 255.0, parts[2] / 255.0, a])
}

fn parse_hex_color(hex: &str) -> Option<[f32; 4]> {
    let expand = |c: char| -> Option<u8> { u8::from_str_radix(&format!("{c}{c}"), 16).ok() };
    match hex.len() {
        3 => {
            let mut chars = hex.chars();
            let r = expand(chars.next()?)?;
            let g = expand(chars.next()?)?;
            let b = expand(chars.next()?)?;
            Some([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0])
        }
        6 | 8 => {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            let a = if hex.len() == 8 { u8::from_str_radix(&hex[6..8], 16).ok()? } else { 255 };
            Some([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, a as f32 / 255.0])
        }
        _ => None,
    }
}

fn named_color(name: &str) -> Option<[f32; 4]> {
    if name.eq_ignore_ascii_case("transparent") {
        return Some([0.0, 0.0, 0.0, 0.0]);
    }
    let rgb: (u8, u8, u8) = match name.to_ascii_lowercase().as_str() {
        "black" => (0, 0, 0),
        "white" => (255, 255, 255),
        "red" => (255, 0, 0),
        "green" => (0, 128, 0),
        "blue" => (0, 0, 255),
        "yellow" => (255, 255, 0),
        "gray" | "grey" => (128, 128, 128),
        "lightgray" | "lightgrey" => (211, 211, 211),
        "darkgray" | "darkgrey" => (169, 169, 169),
        "orange" => (255, 165, 0),
        "purple" => (128, 0, 128),
        "pink" => (255, 192, 203),
        "cyan" | "aqua" => (0, 255, 255),
        "magenta" | "fuchsia" => (255, 0, 255),
        "silver" => (192, 192, 192),
        "navy" => (0, 0, 128),
        "teal" => (0, 128, 128),
        "maroon" => (128, 0, 0),
        "olive" => (128, 128, 0),
        "lime" => (0, 255, 0),
        "indigo" => (75, 0, 130),
        "violet" => (238, 130, 238),
        "brown" => (165, 42, 42),
        "gold" => (255, 215, 0),
        "coral" => (255, 127, 80),
        "salmon" => (250, 128, 114),
        "khaki" => (240, 230, 140),
        "crimson" => (220, 20, 60),
        "beige" => (245, 245, 220),
        "ivory" => (255, 255, 240),
        "tomato" => (255, 99, 71),
        "skyblue" | "lightblue" => (135, 206, 235),
        "steelblue" => (70, 130, 180),
        "slategray" | "slategrey" => (112, 128, 144),
        _ => return None,
    };
    Some([rgb.0 as f32 / 255.0, rgb.1 as f32 / 255.0, rgb.2 as f32 / 255.0, 1.0])
}

/// Only the common single-value-per-part shorthand ("2px solid #333") - order-independent,
/// ignores the style keyword entirely (always drawn as a solid stroke).
fn parse_border(s: &str) -> Option<([f32; 4], f32)> {
    if s.trim().eq_ignore_ascii_case("none") {
        return None;
    }
    let mut width = 1.0f32;
    let mut color = [0.0, 0.0, 0.0, 1.0];
    let mut found_any = false;
    for tok in s.split_whitespace() {
        if let Some(Len::Px(px)) = parse_len(tok) {
            width = px;
            found_any = true;
            continue;
        }
        if let Some(c) = parse_color(tok) {
            color = c;
            found_any = true;
        }
    }
    if found_any {
        Some((color, width))
    } else {
        None
    }
}
