Feature: The running DAW shows a track's reverb as a 3D room and shapes it with an EQ

  The real compiled DAW is launched against a clean data folder. Reverb & EQ opens from the
  transport bar; a reverb preset and two EQ bands (sent as the widget's own events, exactly as a
  drag on its nodes sends them) reshape the 3D room and the waterfall; the live view follows the
  song while it plays; an AI tool can set the same things; and the instrument windows open from the
  transport bar's Instruments menu. tests/daw_space_live.rs checks the captures.

  Scenario: Open Reverb & EQ from the transport bar
    Given the real DAW is running in test mode
    When I advance 40 frames
    And I click "toggle_analyzer"
    And I click "select_track_2"
    And I advance 10 frames
    Then I capture "space-00-transport-bar"
    When I click "toggle_space"
    And I advance 20 frames
    Then I capture "space-01-open"

  Scenario: A concert hall with a boosted bell and a low cut
    # "Concert hall" is the fifth reverb preset (entry 0 is "Custom").
    When I set "space_reverb_preset" to "5"
    And I send the widget event "REVERB_EQ_SELECT|space_view|2"
    And I send the widget event "REVERB_EQ_BAND|space_view|2|peak|1|900|6|1.2"
    And I send the widget event "REVERB_EQ_BAND|space_view|0|lowcut|1|140|0|0.707"
    And I send the widget event "REVERB_EQ_EDIT_END|space_view"
    And I advance 30 frames
    Then I capture "space-02-hall-shaped"

  Scenario: The live view follows the song
    When I send the widget event "REVERB_EQ_VIEW|space_view|live"
    And I click "transport_toggle"
    And I wait 1500 milliseconds
    And I advance 5 frames
    Then I capture "space-03-live"
    When I click "transport_toggle"
    And I advance 5 frames

  Scenario: An AI tool sets a cathedral and a darker tail
    When I send the widget event "REVERB_EQ_VIEW|space_view|decay"
    And I call the tool "daw_reverb_eq" with {"trackId":"trk-lead","reverbPreset":"cathedral","eqPreset":"dark-verb"}
    And I advance 30 frames
    Then I capture "space-04-cathedral"

  Scenario: The instrument windows live in one menu
    When I click "toggle_space"
    # "Wavetable" is the second entry of the Instruments menu.
    And I set "instrument_windows" to "2"
    And I advance 20 frames
    Then I capture "space-05-wavetable-from-menu"
