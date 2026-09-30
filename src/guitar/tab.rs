//! Which string can play which note. The chord detector asks one question of it on the audio thread,
//! "could a guitar in this tuning sound all of these at once?", and a tab view can ask a second one,
//! "where on the neck is that chord most likely played?".
//!
//! A string sounds one note at a time, so a set of notes is playable only if each can be given a string
//! of its own. That rules out more than it seems: E2 to G#2 only exist on the low E string, so no two
//! of them ring together, and nothing below the low string exists at all.

/// Strings as a bitmask (bit 0 is the lowest string) that can play `note` in `tuning` on a neck with
/// `frets` frets.
pub fn strings_for(note: u8, tuning: &[u8; 6], frets: u8) -> u8 {
    let mut mask = 0u8;
    for (s, &open) in tuning.iter().enumerate() {
        if note >= open && note - open <= frets {
            mask |= 1 << s;
        }
    }
    mask
}

/// True when every note in `notes` can have a string to itself. Allocation free (it is called on the
/// audio thread): a bipartite matching over at most six strings.
pub fn playable(notes: &[u8], tuning: &[u8; 6], frets: u8) -> bool {
    if notes.len() > 6 {
        return false;
    }
    let mut masks = [0u8; 6];
    for (i, &n) in notes.iter().enumerate() {
        masks[i] = strings_for(n, tuning, frets);
        if masks[i] == 0 {
            return false;
        }
    }
    // owner[s] = index into notes of the note using string s.
    let mut owner = [usize::MAX; 6];
    for i in 0..notes.len() {
        let mut seen = 0u8;
        if !augment(i, &masks, &mut owner, &mut seen) {
            return false;
        }
    }
    true
}

fn augment(i: usize, masks: &[u8; 6], owner: &mut [usize; 6], seen: &mut u8) -> bool {
    for s in 0..6 {
        let bit = 1u8 << s;
        if masks[i] & bit == 0 || *seen & bit != 0 {
            continue;
        }
        *seen |= bit;
        if owner[s] == usize::MAX || augment(owner[s], masks, owner, seen) {
            owner[s] = i;
            return true;
        }
    }
    false
}

/// A fingering: the fret played on each string, lowest string first. `None` is a string not played.
pub type Fingering = [Option<u8>; 6];

/// The most compact way to play `notes` together: each on its own string, with the fretted notes
/// (open strings do not count) spanning as few frets as possible, and lower on the neck breaking ties.
/// `None` when no hand could play them. For display and for a tab view, not the audio thread.
pub fn fingering(notes: &[u8], tuning: &[u8; 6], frets: u8) -> Option<Fingering> {
    if notes.len() > 6 || notes.is_empty() {
        return None;
    }
    let mut best: Option<(u32, Fingering)> = None;
    let mut current: Fingering = [None; 6];
    search(notes, 0, tuning, frets, &mut current, &mut best);
    best.map(|(_, f)| f)
}

fn search(notes: &[u8], i: usize, tuning: &[u8; 6], frets: u8, current: &mut Fingering, best: &mut Option<(u32, Fingering)>) {
    if i == notes.len() {
        let fretted = current.iter().flatten().copied().filter(|&f| f > 0);
        let (lo, hi, sum) = fretted.fold((u8::MAX, 0u8, 0u32), |(lo, hi, sum), f| (lo.min(f), hi.max(f), sum + f as u32));
        let span = if hi == 0 { 0 } else { (hi - lo) as u32 };
        // Span first, then how far up the neck.
        let cost = span * 1000 + sum;
        if best.as_ref().map_or(true, |(c, _)| cost < *c) {
            *best = Some((cost, *current));
        }
        return;
    }
    let n = notes[i];
    for s in 0..6 {
        if current[s].is_some() || n < tuning[s] || n - tuning[s] > frets {
            continue;
        }
        current[s] = Some(n - tuning[s]);
        search(notes, i + 1, tuning, frets, current, best);
        current[s] = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guitar::config::STANDARD_TUNING as STD;

    #[test]
    fn the_low_notes_only_live_on_the_low_string() {
        assert_eq!(strings_for(40, &STD, 24), 0b000001);
        assert_eq!(strings_for(44, &STD, 24), 0b000001);
        assert_eq!(strings_for(45, &STD, 24), 0b000011);
        assert_eq!(strings_for(39, &STD, 24), 0);
        // The top of the neck: only the high E string reaches E6.
        assert_eq!(strings_for(88, &STD, 24), 0b100000);
    }

    #[test]
    fn open_chords_are_playable_and_impossible_sets_are_not() {
        // E major, open: E2 B2 E3 G#3 B3 E4.
        assert!(playable(&[40, 47, 52, 56, 59, 64], &STD, 24));
        // C major, open: C3 E3 G3 C4 E4.
        assert!(playable(&[48, 52, 55, 60, 64], &STD, 24));
        // E2 and F2 both need the low string.
        assert!(!playable(&[40, 41], &STD, 24));
        // Seven notes, six strings.
        assert!(!playable(&[40, 45, 50, 55, 59, 64, 69], &STD, 24));
        // Three notes that only the two lowest strings reach.
        assert!(!playable(&[40, 45, 46], &STD, 24));
        assert!(playable(&[], &STD, 24));
    }

    #[test]
    fn drop_d_opens_the_low_d() {
        let drop_d = [38, 45, 50, 55, 59, 64];
        assert!(!playable(&[38], &STD, 24));
        assert!(playable(&[38, 45, 50], &drop_d, 24));
    }

    #[test]
    fn a_fingering_prefers_the_compact_shape() {
        // A major, open: A2 E3 A3 C#4 E4 -> x 0 2 2 2 0.
        let f = fingering(&[45, 52, 57, 61, 64], &STD, 24).unwrap();
        assert_eq!(f, [None, Some(0), Some(2), Some(2), Some(2), Some(0)]);
        // F major barre: F2 C3 F3 A3 C4 F4 -> 1 3 3 2 1 1.
        let f = fingering(&[41, 48, 53, 57, 60, 65], &STD, 24).unwrap();
        assert_eq!(f, [Some(1), Some(3), Some(3), Some(2), Some(1), Some(1)]);
        assert!(fingering(&[40, 41], &STD, 24).is_none());
    }
}
