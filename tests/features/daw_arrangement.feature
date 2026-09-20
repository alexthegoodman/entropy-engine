Feature: The DAW arranges tracks on a 16-channel timeline

  Scenario: A fresh project shows sixteen lanes with the starter tracks on the first four
    Given the DAW is open
    Then the arrangement shows 16 lanes
    And lane 1 is the track "Drums"
    And lane 4 is the track "Pad"
    And lane 5 is an empty channel
    And lane 16 is an empty channel
    And the arrangement ruler is in bars of 2500 ms with a beat of 625 ms

  Scenario: Every channel can hold a track, and a seventeenth channel appears when they run out
    Given the DAW is open
    When I click "add_synth_track" 12 times
    Then the arrangement shows 16 lanes
    And no lane is an empty channel
    When I click "add_synth_track"
    Then the arrangement shows 17 lanes

  Scenario: Drawing on an empty channel gives it a track and a clip
    Given the DAW is open
    When I draw a clip on lane 9 from bar 2 for 2 bars
    Then lane 9 holds a track with 1 clip
    And the saved project has 5 tracks
    And the saved track on lane 9 has a clip starting at bar 2 lasting 2 bars

  Scenario: Clicking an empty channel starts a track there
    Given the DAW is open
    When I click the header of lane 12
    Then lane 12 holds a track with 0 clips
    And the saved project has 5 tracks

  Scenario: Clips carry a miniature preview of their pattern
    Given the DAW is open
    Then clip "clip-drums-0" previews 12 notes and loops every 2500 ms
    And clip "clip-lead-4" is drawn from 10000 ms for 10000 ms and loops every 5000 ms

  Scenario: A moved clip bumps into its neighbour instead of overlapping it
    Given the DAW is open
    When I move clip "clip-drums-3" to bar 1
    Then clip "clip-drums-3" starts at bar 3
    When I move clip "clip-drums-3" to bar 3.5
    Then clip "clip-drums-3" starts at bar 3
    And the saved project has no overlapping clips

  Scenario: A resized clip stops at the next clip on its lane
    Given the DAW is open
    When I resize clip "clip-bass-2" to end at bar 12
    Then clip "clip-bass-2" starts at bar 2 and ends at bar 8
    When I resize clip "clip-bass-2" to end at bar 5
    Then clip "clip-bass-2" starts at bar 2 and ends at bar 5

  Scenario: Duplicating needs room, and deleting makes it
    Given the DAW is open
    When I duplicate clip "clip-bass-2"
    Then I see the label "No room after that clip for a copy."
    When I delete clip "clip-bass-8"
    And I duplicate clip "clip-bass-2"
    Then lane 2 holds a track with 2 clips
    And the saved track on lane 2 has a clip starting at bar 8 lasting 6 bars

  Scenario: Mute and solo pills in the lane header reach the audio bus
    Given the DAW is open
    When I send the widget event "TRACKS_TRACK_MUTE|arrangement|trk-bass"
    Then track "Bass" is muted on its audio bus
    When I send the widget event "TRACKS_TRACK_SOLO|arrangement|trk-lead"
    Then track "Lead" is soloed on its audio bus

  Scenario: BPM is a typeable field that keeps what is typed until it is valid
    Given the DAW is open
    Then the BPM is 96
    When I set "bpm_input" to "1"
    Then the BPM is 96
    And the BPM box shows "1"
    And I see the label "BPM must be between 20 and 300."
    When I set "bpm_input" to "140"
    Then the BPM is 140
    And the BPM box shows "140"
    And the arrangement ruler is in bars of 1714 ms with a beat of 429 ms
    When I click "bpm_up"
    Then the BPM is 141
    When I click "bpm_down"
    And I click "bpm_down"
    Then the BPM is 139
    When I set "bpm_input" to "999"
    Then the BPM is 139

  Scenario: Changing tempo does not move the playhead
    Given the DAW is open
    When I click "transport_toggle"
    And I advance 6000 milliseconds
    Then the position reads bar 3
    When I set "bpm_input" to "192"
    And I advance 50 milliseconds
    Then the position reads bar 3

  Scenario: Playing the song brings tracks in where the arrangement says
    Given the DAW is open
    When I click "transport_toggle"
    And I advance 4000 milliseconds
    Then track "Drums" has played notes
    And track "Bass" has not played
    And track "Lead" has not played
    When I advance 3000 milliseconds
    Then track "Bass" has played notes
    And track "Lead" has not played
    When I advance 4000 milliseconds
    Then track "Lead" has played notes

  Scenario: Seeking from the ruler moves the playhead, and stopping keeps it there
    Given the DAW is open
    When I send the widget event "TRACKS_SEEK|arrangement|20000"
    Then the position reads bar 9
    When I click "transport_toggle"
    And I advance 200 milliseconds
    And I click "transport_toggle"
    Then the position reads bar 9
    When I click "transport_rewind"
    Then the position reads bar 1

  Scenario: Pattern loop mode plays only the active track's pattern
    Given the DAW is open
    When I choose option 1 of "transport_mode"
    And I click "transport_toggle"
    And I advance 3000 milliseconds
    Then track "Drums" has played notes
    And track "Bass" has not played
    And track "Pad" has not played

  Scenario: The WAV export renders the arrangement, not one loop
    Given the DAW is open
    When I click "export_wav"
    Then the export has notes after 37 seconds
    And the export has no "saw" notes before 5 seconds
    And the export has no "square" notes before 10 seconds

  Scenario: Painting notes on a track with no clips gives it one
    Given the DAW is open
    When I click "add_synth_track"
    And I paint a note on row 2 at step 4
    Then lane 5 holds a track with 1 clip
    And the saved track on lane 5 has a clip starting at bar 0 lasting 16 bars

  Scenario: A second pattern is a variation that plays where its clip is
    Given the DAW is open
    When I send the widget event "TRACKS_CLIP_SELECTED|arrangement|trk-drums|clip-drums-3"
    And I click "pattern_duplicate"
    Then clip "clip-drums-3" plays a pattern named "Fill copy"
    And clip "clip-drums-0" plays a pattern named "Groove"

  Scenario: An AI can arrange a whole track with one call
    Given the DAW is open
    When I call the tool "daw_create_track" with {"name":"Arp","kind":"synth"}
    And I call the tool "daw_set_notes" for that track with {"rows":[{"row":3,"pattern":"X.x.X.x.X.x.X.x."}]}
    And I call the tool "daw_place_clips" for that track with {"mode":"replace","clips":[{"startBar":4,"bars":4},{"startBar":8,"bars":4},{"startBar":10,"bars":4}]}
    Then the tool result skipped 1 clip
    And lane 5 holds a track with 2 clips

  Scenario: A project saved before the arrangement existed still opens and still plays
    Given the DAW is open on a project saved before arrangements existed
    Then lane 1 is the track "Old drums"
    And lane 1 holds a track with 1 clip
    And the saved track on lane 1 has a clip starting at bar 0 lasting 8 bars
    When I click "transport_toggle"
    And I advance 400 milliseconds
    Then track "Old drums" has played notes
