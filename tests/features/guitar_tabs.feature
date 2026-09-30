Feature: Learning a guitar tab with Guitar-to-MIDI

  The Guitar Tabs app (examples/studio-bundle/src/apps/tabs) reads a pasted ASCII tab into steps,
  shows them in a spreadsheet for review, and grades playing against them. These scenarios run the
  production modules under vitest (examples/studio-bundle/tests/guitar_tabs.test.ts). Tabs are written
  inline with "/" for a line break; strings are named as a tab names them, notes as C4.

  Scenario: A single-note melody becomes one step per note, in bars, with lengths from the spacing
    Given the example tab "ode_to_joy"
    When it is parsed
    Then there are 15 steps in 4 bars and no warnings
    And the title is "Ode to Joy (Beethoven)" at 100 BPM
    And step 1 plays "E4" on the e string at fret 0 in bar 1 for 1 beats
    And step 13 plays "E4" on the e string at fret 0 in bar 4 for 1.5 beats
    And step 14 plays "D4" on the B string at fret 3 in bar 4 for 0.5 beats
    And the plan is pick mode throughout

  Scenario: Notes stacked in one column are a chord, and x marks a muted string
    Given the example tab "open_chords"
    When it is parsed
    Then there are 8 steps in 4 bars and no warnings
    And step 1 sounds "G2 B2 D3 G3 B3 G4"
    And step 3 sounds "C3 E3 G3 C4 E4" with the low E string muted
    And step 5 sounds "D3 A3 D4 F#4" with strings E and A muted
    And every step lasts 2 beats
    And the plan is chord mode throughout

  Scenario: Two-digit frets line up with the single digits of their chord either way they are aligned
    Given the tab "e|--10---12--|/B|--10---12--|/G|--11---9---|/D|--12---10--|/A|--------12-|/E|-----------|"
    When it is parsed
    Then there are 2 steps in 1 bars and no warnings
    And step 1 sounds "D4 F#4 A4 D5"
    And step 2 sounds "A3 C4 E4 B4 E5"

  Scenario: A tab written lowest string first is turned the right way up
    Given the tab "E|--3--|/A|--2--|/D|--0--|/G|--0--|/B|--0--|/e|--3--|"
    When it is parsed
    Then step 1 sounds "G2 B2 D3 G3 B3 G4"

  Scenario: String names give the tuning
    Given the tab "e|-----|/B|-----|/G|-----|/D|--0--|/A|-----|/D|--0--|"
    When it is parsed
    Then the tuning is "D2 A2 D3 G3 B3 E4"
    And step 1 sounds "D2 D3"

  Scenario: A tuning line is read when the strings are not named
    Given the tab "Tuning: DADGAD/|-----|/|--0--|/|-----|/|-----|/|-----|/|--0--|"
    When it is parsed
    Then the tuning is "D2 A2 D3 G3 A3 D4"
    And step 1 sounds "D2 A3"

  Scenario: A palm-mute row over the strings does not break the system apart
    Given the tab "PM-------|/e|-------|/B|-------|/G|-------|/D|-------|/A|-------|/E|0-0-3--|"
    When it is parsed
    Then there are 3 steps in 1 bars and no warnings

  Scenario: Text that is not a tab says so
    Given the tab "just some words/and a second line"
    When it is parsed
    Then there are 0 steps and a warning mentioning "No tab found"

  Scenario: A let-ring arpeggio is heard in chord mode, a plain melody in pick mode
    Given the example tab "minor_arpeggio"
    When it is parsed
    Then there are 32 steps in 4 bars and no warnings
    And the plan is chord mode throughout
    Given the example tab "warmup"
    When it is parsed
    Then the plan is pick mode throughout

  Scenario: One or two single notes between chords stay in chord mode, a longer line switches
    Given the tab "e|0---0-0-----0-2-3-5-7---|/B|1-----------1---------1-|/G|0-----------0---------0-|/D|2-----------2---------2-|/A|3-----------3---------3-|/E|------------------------|"
    When it is parsed
    Then the plan is "chord chord chord chord pick pick pick pick chord"

  Scenario: The review sheet shows every step and takes edits back into the song
    Given the example tab "open_chords"
    When it is parsed
    Then the sheet header reads "Step, Bar, Beats, e string, B string, G string, D string, A string, E string, Notes, Play as"
    And sheet row 3 reads "3, 2, 2, 0, 1, 0, 2, 3, x, C3 E3 G3 C4 E4, auto (chord)"
    When sheet row 3 column "E string" is set to "3"
    Then the edit is accepted and step 3 sounds "G2 C3 E3 G3 C4 E4"
    When sheet row 3 column "E string" is set to "30"
    Then the edit is refused with "A fret is 0 to 24"
    When sheet row 9 column "e string" is set to "5"
    Then the edit is accepted and there are 9 steps
    And step 9 sounds "A4"
    When sheet row 9 column "Play as" is set to "pick"
    Then the edit is accepted and the plan for step 9 is "pick"
    When sheet row 0 column "Bar" is set to "2"
    Then the edit is refused with "header row"

  Scenario: A song written back out as tab reads back the same
    Given the example tab "minor_arpeggio"
    When it is parsed
    And it is written out as tab and parsed again
    Then both readings have the same notes, bars and beats

  Scenario: Fingers follow the frets under one hand, open strings take none
    Given the example tab "warmup"
    When it is parsed
    Then steps 1 to 4 are fingered "1, 2, 3, 4"
    Given the example tab "open_chords"
    When it is parsed
    Then step 3 is fingered "3 2 0 1 0" lowest string first
    And step 1 is fingered "2 1 0 0 0 3" lowest string first
    And step 5 is fingered "0 1 3 2" lowest string first
    Given the tab "e|--1--|/B|--1--|/G|--2--|/D|--3--|/A|--3--|/E|--1--|"
    When it is parsed
    Then step 1 is fingered "1 3 4 2 1 1" lowest string first

  Scenario: At your own pace the cursor waits for the right note and counts wrong ones
    Given the example tab "ode_to_joy" in "wait" practice
    When the practice starts at 0 ms
    Then the current step is 1
    When "F4" is played at 500 ms
    Then the events are "wrong F4" and the current step is 1
    When "E4" is played at 900 ms
    Then the events are "hit 1, advance 2" and the current step is 2
    When "E4" is played at 1500 ms
    Then the events are "hit 2, advance 3"
    And the stats read 2 hits, 0 misses, 1 wrong, streak 2

  Scenario: A chord is gathered over several readings; played leniently its bass and pitch classes are enough
    Given the example tab "open_chords" in "wait" practice
    When the practice starts at 0 ms
    And "G2 B2" is played at 100 ms
    Then there are no events
    When "D3" is played at 150 ms
    Then the events are "hit 1, advance 2"
    Given the example tab "open_chords" in "wait" practice without lenient chords
    When the practice starts at 0 ms
    And "G2 B2 D3 G3 B3" is played at 100 ms
    Then there are no events

  Scenario: In real time each step must land in its window, late or early by a little is fine
    Given the example tab "ode_to_joy" in "realtime" practice at 100 percent tempo with a 4 beat count-in
    When the practice starts at 0 ms
    Then the first step is due at 2400 ms
    When time reaches 600 ms
    Then the events include "beat -4, beat -3"
    When time reaches 2400 ms
    Then the events include "due 1"
    When "E4" is played at 2450 ms
    Then the events are "hit 1 +50"
    When time reaches 3500 ms
    Then the events include "miss 2"
    When "F4" is played at 3570 ms
    Then the events are "hit 3 -30"
    And the stats read 2 hits, 1 misses, 0 wrong, streak 1

  Scenario: The detector's latency is taken off a note's time
    Given the example tab "ode_to_joy" in "realtime" practice at 100 percent tempo with a 0 beat count-in
    When the practice starts at 0 ms
    And "E4" is played at 90 ms with 80 ms of latency
    Then the events are "hit 1 +10"

  Scenario: Half tempo stretches the schedule, and a loop starts the range again
    Given the example tab "ode_to_joy" in "listen" practice at 50 percent tempo with a 0 beat count-in, looping steps 1 to 2
    When the practice starts at 0 ms
    Then step 2 is due at 1200 ms
    When time reaches 2500 ms
    Then the events include "due 2, loop, due 1"

  Scenario: Onsets come from new notes, re-picks, and pick-mode hammer-ons
    Given an onset tracker
    Then reading "A2" with 1 note-ons gives "A2"
    And reading "A2" with 1 note-ons gives ""
    And reading "A2" with 2 note-ons gives "A2"
    And reading "A2" with 2 note-ons at pitch "B2" off by 40 cents gives ""
    And reading "A2" with 2 note-ons at pitch "B2" off by 5 cents gives "B2"
    And reading "A2" with 2 note-ons at pitch "A2" off by 5 cents gives "A2"
    And reading "" with 2 note-ons gives ""
    And reading "E3 G3" with 3 note-ons gives "E3 G3"
