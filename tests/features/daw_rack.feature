Feature: Drum tracks play samples from the Music folder

  The production DAW addon runs against a stand-in engine that records every call it makes, and the
  widgets it draws are captured each frame, so a step calls exactly the callbacks the real tree and
  pad grid would. The disk is a fake one built by the steps below; "decoding" a file reports its
  length and a waveform. Nothing here judges how anything sounds: the real decoder, the real
  output device and the real screen are covered by sample_rack_bdd (engine) and daw_rack_live.

  Scenario: A drum track starts as the five built-in pads
    Given the DAW is open
    Then the rack has 5 pads
    And the pad "Kick" is a "synth" pad
    And the pad "Tom" is a "synth" pad
    And the piano roll has 5 rows labelled "Kick, Snare, Hihat, Clap, Tom"

  Scenario: The browser opens on the Music folder, folders first, with counts
    Given the disk has a Music folder
    And the disk has the folder "C:/Music/Drum Kit"
    And the disk has the folder "C:/Music/Album"
    And the disk has the sample "C:/Music/Drum Kit/kick_808.wav" of 0.4 seconds
    And the disk has the sample "C:/Music/Drum Kit/snare_tight.wav" of 0.3 seconds
    And the disk has the sample "C:/Music/Drum Kit/hat.wav" of 0.1 seconds
    And the disk has the sample "C:/Music/loose_loop.wav" of 2 seconds
    When the DAW is open
    Then the tree row "Music" is at depth 0
    And the tree row "Album" is at depth 1 and says "empty"
    And the tree row "Drum Kit" is at depth 1 and says "3 samples"
    And the tree row "loose_loop.wav" is at depth 1
    And the tree row "Album" comes before the tree row "loose_loop.wav"
    When I select the tree row "Drum Kit"
    Then the tree row "kick_808.wav" is at depth 2
    And the tree row "hat.wav" is at depth 2
    When I select the tree row "Drum Kit"
    Then the tree has no row "kick_808.wav"

  Scenario: Clicking a file plays it and arms it without touching any pad
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "kick_808.wav"
    Then the engine was asked to preview "C:/Music/Drum Kit/kick_808.wav"
    And the preview card shows "kick_808" as armed
    And the pad "Kick" is a "synth" pad

  Scenario: Select a file, then click a pad, and the sample is on the pad
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "kick_808.wav"
    And I click the pad "Kick"
    Then the pad "Kick" is a "sample" pad
    And the pad "Kick" is captioned "kick_808"
    And the pad "Kick" has a waveform
    And the saved project has "C:/Music/Drum Kit/kick_808.wav" on pad 0 of "Drums"
    And I see a label containing "kick_808 is on Kick."
    And the engine played "C:/Music/Drum Kit/kick_808.wav" on the track "Drums" straight away

  Scenario: Only the click after picking a file places it
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "kick_808.wav"
    And I click the pad "Kick"
    And I click the pad "Snare"
    Then the pad "Snare" is a "synth" pad
    And the pad "Kick" is a "sample" pad

  Scenario: The song plays a pad's sample where it played the synth voice
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "kick_808.wav"
    And I click the pad "Kick"
    And I forget what has been played
    And I click "transport_toggle"
    And I advance 2000 milliseconds
    Then the track "Drums" has played the sample "C:/Music/Drum Kit/kick_808.wav"
    And the track "Drums" has not played the built-in voice "kick"
    And the track "Drums" has played the built-in voice "snare"

  Scenario: A hit's velocity becomes the sample's gain
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "hat.wav"
    And I click the pad "Hihat"
    And I forget what has been played
    And I click "transport_toggle"
    And I advance 1000 milliseconds
    Then every hit of "C:/Music/Drum Kit/hat.wav" has a gain between 0.5 and 0.75

  Scenario: Trim, pitch and gain are saved and reach the engine
    Given a disk with a drum kit folder
    And the DAW is open
    When I call the tool "daw_set_pad_sample" with {"trackId":"trk-drums","row":0,"path":"C:/Music/Drum Kit/kick_808.wav","start":0.25,"end":0.75,"semitones":-3,"gain":1.5,"gate":true}
    Then the tool succeeded
    And the saved project has the trim 0.25 to 0.75 on pad 0 of "Drums"
    When I click the pad "Kick"
    Then the last sample hit on "Drums" has start 0.25, end 0.75, semitones -3 and a hold

  Scenario: The pad editor's sliders change the selected pad
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "snare_tight.wav"
    And I click the pad "Snare"
    And I drag the slider "Start" to 0.2
    And I drag the slider "Pitch (semitones)" to 4
    And I drag the slider "Sample gain" to 0.5
    Then the saved project has the trim 0.2 to 1 on pad 1 of "Drums"
    And the saved project has 4 semitones and a gain of 0.5 on pad 1 of "Drums"

  Scenario: Start can never pass end
    Given a disk with a drum kit folder
    And the DAW is open
    When I call the tool "daw_set_pad_sample" with {"trackId":"trk-drums","row":0,"path":"C:/Music/Drum Kit/kick_808.wav"}
    And I drag the slider "End" to 0.4
    And I drag the slider "Start" to 0.9
    Then the saved project has a trim that starts before it ends on pad 0 of "Drums"

  Scenario: Right-clicking a pad takes its sample off and the built-in voice returns
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "kick_808.wav"
    And I click the pad "Kick"
    And I right-click the pad "Kick"
    Then the pad "Kick" is a "synth" pad
    And the saved project has no sample on pad 0 of "Drums"

  Scenario: An added pad is an empty row that takes the file's name
    Given a disk with a drum kit folder
    And the DAW is open
    When I click the add tile
    Then the rack has 6 pads
    And the pad "Pad 6" is an "empty" pad
    And the piano roll has 6 rows
    When I select the tree row "Drum Kit"
    And I select the tree row "hat.wav"
    And I click the pad "Pad 6"
    Then the pad "hat" is a "sample" pad
    And the saved project has "C:/Music/Drum Kit/hat.wav" on pad 5 of "Drums"

  Scenario: A rack holds sixteen pads
    Given the DAW is open
    When I click the add tile 11 times
    Then the rack has 16 pads
    And the pad grid has no add tile
    And the piano roll has 16 rows

  Scenario: A pad glows when it is hit and settles
    Given a disk with a drum kit folder
    And the DAW is open
    When I click the pad "Snare"
    Then the pad "Snare" is glowing
    When I advance 400 milliseconds
    Then the pad "Snare" is not glowing

  Scenario: A long file is used from its start and says so
    Given a disk with a drum kit folder
    And the disk has the sample "C:/Music/Drum Kit/whole_song.mp3" of 200 seconds
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "whole_song.mp3"
    Then I see a label containing "12.0 s of 3:20"
    When I click the pad "Tom"
    Then I see a label containing "Only the first 12.0 s of the file is used."

  Scenario: The filter narrows the files and keeps the folders
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I set "browser_filter" to "SNARE"
    Then the tree lists "snare_tight.wav"
    And the tree has no row "kick_808.wav"
    And the tree lists "Drum Kit"

  Scenario: A file that goes missing shows red, plays nothing, and is left out of the export
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "kick_808.wav"
    And I click the pad "Kick"
    And the file "C:/Music/Drum Kit/kick_808.wav" is deleted from the disk
    And I click "browser_refresh"
    Then the pad "Kick" is a "missing" pad
    When I forget what has been played
    And I click "transport_toggle"
    And I advance 2000 milliseconds
    Then the track "Drums" has not played the built-in voice "kick"
    And the track "Drums" has not played any sample
    When I click "transport_toggle"
    And I click "export_wav"
    Then the export has no sample hits

  Scenario: Reopening a project whose sample has moved shows the pad red
    Given a disk with a drum kit folder
    And the DAW is open
    When I call the tool "daw_set_pad_sample" with {"trackId":"trk-drums","row":2,"path":"C:/Music/Drum Kit/hat.wav"}
    And the DAW is reopened without "C:/Music/Drum Kit/hat.wav" on the disk
    Then the pad "Hihat" is a "missing" pad
    And the pad "Kick" is a "synth" pad

  Scenario: The export renders sample pads from their files
    Given a disk with a drum kit folder
    And the DAW is open
    When I select the tree row "Drum Kit"
    And I select the tree row "kick_808.wav"
    And I click the pad "Kick"
    And I click "export_wav"
    Then the export has sample hits of "C:/Music/Drum Kit/kick_808.wav" from 0 seconds
    And the export has no "kick" notes before 100 seconds

  Scenario: A project saved before drum racks gets the five built-in pads
    Given the DAW is open on a project saved before drum racks existed
    Then the rack has 5 pads
    And the pad "Snare" is a "synth" pad
    And the saved project has 5 pads on "Old drums"

  Scenario: The AI can browse folders and put a sample on a pad
    Given a disk with a drum kit folder
    And the DAW is open
    When I call the tool "daw_browse_samples" with {}
    Then the tool succeeded
    And the tool result lists the folder "Drum Kit"
    When I call the tool "daw_browse_samples" with {"path":"C:/Music/Drum Kit"}
    Then the tool result lists the file "snare_tight.wav"
    When I call the tool "daw_set_pad_sample" with {"trackId":"trk-drums","row":1,"path":"C:/Music/Drum Kit/snare_tight.wav","name":"Big Snare"}
    Then the tool succeeded
    And the pad "Big Snare" is a "sample" pad
    When I call the tool "daw_get_state" with {}
    Then the state shows pad 1 of "Drums" playing a "sample"

  Scenario: The AI is told when it asks for something a pad cannot do
    Given a disk with a drum kit folder
    And the DAW is open
    When I call the tool "daw_set_pad_sample" with {"trackId":"trk-drums","row":99,"path":"C:/Music/Drum Kit/hat.wav"}
    Then the tool failed saying "No pad at row 99"
    When I call the tool "daw_set_pad_sample" with {"trackId":"trk-bass","row":0,"path":"C:/Music/Drum Kit/hat.wav"}
    Then the tool failed saying "Only drum tracks have pads"
    When I call the tool "daw_set_pad_sample" with {"trackId":"trk-drums","row":0,"path":"C:/Music/nothing.wav"}
    Then the tool failed saying "could not open"
    And the pad "Kick" is a "synth" pad

  Scenario: A folder outside the readable ones is refused with a message, not a crash
    Given the DAW is open
    When I call the tool "daw_browse_samples" with {"path":"C:/Windows"}
    Then the tool failed saying "outside the folders"

  Scenario: The rack is a window of its own that can be hidden and shown again
    Given the DAW is open
    Then the drum rack window is shown
    When I click "toggle_rack"
    Then the drum rack window is hidden
    When I click "toggle_rack"
    Then the drum rack window is shown

  Scenario: With a synth track selected the rack asks for a drum track instead of showing pads
    Given a disk with a drum kit folder
    And the DAW is open
    When I click "select_track_1"
    Then the pad grid is not drawn
    And I see the label "The rack belongs to a drum track."
    And the tree row "Drum Kit" is at depth 1
    When I click "rack_add_drum_track"
    Then the rack has 5 pads
