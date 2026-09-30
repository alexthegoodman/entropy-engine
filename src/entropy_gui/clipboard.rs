//! The OS clipboard as plain text, for Ctrl+V in text fields and `Entropy.Clipboard`. A clipboard
//! that cannot be reached (no display server, another program holding it) reads as empty rather than
//! failing: pasting nothing is the right outcome for a keystroke.

/// The clipboard's text with line endings normalised to `\n`, or None when it holds no text.
pub fn read_text() -> Option<String> {
    let text = arboard::Clipboard::new().ok()?.get_text().ok()?;
    Some(normalize(&text))
}

/// Sets the clipboard's text. False when the clipboard could not be reached.
pub fn write_text(text: &str) -> bool {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_owned())).is_ok()
}

/// `\r\n` and lone `\r` become `\n`; tabs stay (a text field indents with spaces, but a pasted tab
/// stop is the user's own text).
pub fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// What a single-line field keeps of pasted text: its lines joined by spaces.
pub fn single_line(text: &str) -> String {
    text.lines().map(str::trim_end).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_endings_are_normalised_and_single_lines_joined() {
        assert_eq!(normalize("e|--0--|\r\nB|--1--|\rG|--0--|"), "e|--0--|\nB|--1--|\nG|--0--|");
        assert_eq!(single_line("first line  \n\nsecond"), "first line second");
    }
}
