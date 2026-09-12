//! Renders arbitrary HTML (including real, fetched-off-the-internet webpages) as a flat list
//! of `UiWidget`s, so an addon can hand `<div>...</div>` markup to `entropy_gui` instead of
//! calling `Entropy.UI.Widget.*` imperatively. There is no CSS engine here at all - no box
//! model, no layout, no styling beyond "headings are bold" - every element is either a block
//! (flushed onto its own line) or inline (its text merges into the current line). That's the
//! whole experiment: see how far tag-shape alone gets you with zero style parsing.
//!
//! `<script>`/`<style>`/`<head>` and friends are dropped outright (their content is never
//! valid UI text). Anything genuinely visual - `<canvas>`, `<svg>`, real `<img>` bitmaps - has
//! no widget to become, so it's replaced with a `[image: alt-or-src]` label rather than
//! silently vanishing.

use super::addon_ops::UiWidget;
use scraper::{Html, Node};

/// Hard cap on emitted widgets. A real page (Wikipedia, a news homepage) can easily contain
/// tens of thousands of text nodes once nav/footer/boilerplate is included - past this point
/// we stop walking rather than hand the immediate-mode renderer an unbounded frame.
const MAX_WIDGETS: usize = 1500;

struct Walker {
    out: Vec<UiWidget>,
    line: String,
    line_bold: bool,
    counter: usize,
    truncated: bool,
}

impl Walker {
    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("html_{}_{}", prefix, self.counter)
    }

    fn push_text(&mut self, raw: &str) {
        let fragment: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if fragment.is_empty() {
            return;
        }
        if !self.line.is_empty() && !self.line.ends_with(' ') {
            self.line.push(' ');
        }
        self.line.push_str(&fragment);
    }

    fn flush(&mut self) {
        let text = self.line.trim().to_string();
        self.line.clear();
        if text.is_empty() {
            return;
        }
        self.push_widget(UiWidget::Label { text, bold: Some(self.line_bold) });
    }

    fn push_widget(&mut self, widget: UiWidget) {
        if self.truncated {
            return;
        }
        if self.out.len() >= MAX_WIDGETS {
            self.truncated = true;
            self.out.push(UiWidget::Label { text: "... (truncated - page too large to render in full)".into(), bold: Some(true) });
            return;
        }
        self.out.push(widget);
    }
}

fn text_content(node: ego_tree::NodeRef<'_, Node>) -> String {
    let mut buf = String::new();
    for descendant in node.descendants() {
        if let Node::Text(t) = descendant.value() {
            if !buf.is_empty() && !buf.ends_with(' ') {
                buf.push(' ');
            }
            buf.push_str(t);
        }
    }
    buf.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn attr<'a>(node: ego_tree::NodeRef<'a, Node>, name: &str) -> Option<&'a str> {
    match node.value() {
        Node::Element(el) => el.attr(name),
        _ => None,
    }
}

fn tag_name<'a>(node: ego_tree::NodeRef<'a, Node>) -> Option<&'a str> {
    match node.value() {
        Node::Element(el) => Some(el.name()),
        _ => None,
    }
}

fn recurse_children(node: ego_tree::NodeRef<'_, Node>, w: &mut Walker) {
    for child in node.children() {
        walk(child, w);
        if w.truncated {
            break;
        }
    }
}

fn walk(node: ego_tree::NodeRef<'_, Node>, w: &mut Walker) {
    if w.truncated {
        return;
    }
    match node.value() {
        Node::Text(text) => w.push_text(text),
        Node::Element(el) => {
            let tag = el.name();

            // Non-visual / non-text subtrees: skip entirely, don't even collect their text.
            if matches!(tag, "script" | "style" | "head" | "noscript" | "template" | "svg" | "meta" | "link" | "iframe" | "object" | "canvas") {
                return;
            }

            match tag {
                "br" => {
                    w.flush();
                    return;
                }
                "hr" => {
                    w.flush();
                    w.push_widget(UiWidget::Separator);
                    return;
                }
                "img" => {
                    w.flush();
                    let alt = attr(node, "alt").filter(|s| !s.is_empty());
                    let src = attr(node, "src").unwrap_or("");
                    let desc = alt.unwrap_or(src);
                    w.push_widget(UiWidget::Label { text: format!("[image: {}]", desc), bold: Some(false) });
                    return;
                }
                "a" => {
                    let text = text_content(node);
                    let href = attr(node, "href").unwrap_or("#").to_string();
                    if !text.is_empty() {
                        w.flush();
                        let id = w.next_id("a");
                        w.push_widget(UiWidget::Hyperlink { id, text, url: href });
                    }
                    return;
                }
                "button" => {
                    w.flush();
                    let text = {
                        let t = text_content(node);
                        if t.is_empty() { attr(node, "value").unwrap_or("Button").to_string() } else { t }
                    };
                    let id = w.next_id("button");
                    w.push_widget(UiWidget::Button { id: id.clone(), text: text.clone(), label: text });
                    return;
                }
                "input" => {
                    w.flush();
                    let input_type = attr(node, "type").unwrap_or("text");
                    let label = attr(node, "placeholder").or_else(|| attr(node, "name")).unwrap_or("").to_string();
                    let id = w.next_id("input");
                    match input_type {
                        "checkbox" | "radio" => {
                            let value = attr(node, "checked").is_some();
                            w.push_widget(UiWidget::Checkbox { id, label, value });
                        }
                        "range" => {
                            let min = attr(node, "min").and_then(|s| s.parse().ok()).unwrap_or(0.0);
                            let max = attr(node, "max").and_then(|s| s.parse().ok()).unwrap_or(100.0);
                            let value = attr(node, "value").and_then(|s| s.parse().ok()).unwrap_or(min);
                            w.push_widget(UiWidget::Slider { id, label, value, min, max });
                        }
                        "number" => {
                            let value = attr(node, "value").and_then(|s| s.parse().ok()).unwrap_or(0.0);
                            w.push_widget(UiWidget::NumericInput { id, label, value });
                        }
                        "button" | "submit" | "reset" => {
                            let text = attr(node, "value").unwrap_or("Submit").to_string();
                            w.push_widget(UiWidget::Button { id: id.clone(), text: text.clone(), label: text });
                        }
                        "hidden" => {}
                        _ => {
                            let value = attr(node, "value").unwrap_or("").to_string();
                            w.push_widget(UiWidget::TextInput { id, label, value });
                        }
                    }
                    return;
                }
                "textarea" => {
                    w.flush();
                    let id = w.next_id("textarea");
                    let label = attr(node, "placeholder").unwrap_or("").to_string();
                    let value = text_content(node);
                    w.push_widget(UiWidget::TextInput { id, label, value });
                    return;
                }
                "select" => {
                    w.flush();
                    let id = w.next_id("select");
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
                    w.push_widget(UiWidget::Dropdown { id, label: String::new(), options, selected_index });
                    return;
                }
                "li" => {
                    w.flush();
                    let text = text_content(node);
                    if !text.is_empty() {
                        w.push_widget(UiWidget::Label { text: format!("\u{2022} {}", text), bold: Some(false) });
                    }
                    return;
                }
                "tr" => {
                    w.flush();
                    let mut cells = Vec::new();
                    for child in node.children() {
                        if matches!(tag_name(child), Some("td") | Some("th")) {
                            let cell_text = text_content(child);
                            if !cell_text.is_empty() {
                                cells.push(cell_text);
                            }
                        }
                    }
                    if !cells.is_empty() {
                        w.push_widget(UiWidget::Label { text: cells.join("  |  "), bold: Some(false) });
                    }
                    return;
                }
                _ => {}
            }

            let is_heading = matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
            if is_heading {
                w.flush();
                let text = text_content(node);
                if !text.is_empty() {
                    w.push_widget(UiWidget::Label { text, bold: Some(true) });
                }
                return;
            }

            let is_block = matches!(
                tag,
                "p" | "div" | "section" | "article" | "header" | "footer" | "nav" | "main" | "ul" | "ol" | "table"
                    | "thead" | "tbody" | "blockquote" | "pre" | "form" | "fieldset" | "body" | "html" | "figure" | "figcaption"
            );

            if is_block {
                w.flush();
                recurse_children(node, w);
                w.flush();
            } else {
                // Inline element (span, b, strong, em, i, small, code, label, time, ...) -
                // no styling distinction, its text just merges into the surrounding line.
                recurse_children(node, w);
            }
        }
        // Document/Fragment (the tree root) has no text of its own but must still be walked
        // into, or nothing under it ever renders; Comment/Doctype/ProcessingInstruction have
        // no children so recursing into them too is a harmless no-op.
        _ => recurse_children(node, w),
    }
}

/// Parses `html` and flattens it into `UiWidget`s in document order. Malformed markup is
/// handled the same way a browser would (`scraper`/`html5ever` implement the WHATWG parsing
/// algorithm), which is the point - this is meant to survive real, messy, fetched-off-the-
/// internet pages, not just hand-authored addon markup.
pub fn html_to_widgets(html: &str) -> Vec<UiWidget> {
    let document = Html::parse_document(html);
    let mut w = Walker { out: Vec::new(), line: String::new(), line_bold: false, counter: 0, truncated: false };
    walk(document.tree.root(), &mut w);
    w.flush();
    w.out
}
