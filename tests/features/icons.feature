Feature: Phosphor icons draw inside any label, in three weights

  Each scenario drives the real entropy_gui widgets through a headless context and rasterizes
  the draw list on the CPU, so every assertion about looks is a fact about pixels. A label
  writes an icon as {name} or {name:style} (style is regular, bold or fill); the step expands it
  to the character Entropy.Icons.get would return. {missing} is a private-use character no
  Phosphor weight draws, so it shows what a missing glyph looks like. Pictures land in
  test-artifacts/icons/.

  Scenario: An icon draws a real glyph, not a missing-glyph box
    Given buttons labelled "{play}", "{missing}"
    When a frame is drawn
    Then the "{play}" button has ink
    And the "{play}" button looks different from the "{missing}" button
    And I save the picture "icon-vs-missing"

  Scenario: An icon beside a label does not make the button taller
    Given buttons labelled "Play", "{play} Play", "{play}"
    When a frame is drawn
    Then the "{play} Play" button is as tall as the "Play" button
    And the "{play}" button is as tall as the "Play" button

  Scenario: An icon adds about its own width to a label and replaces it when alone
    Given buttons labelled "Play", "{play} Play", "{play}"
    When a frame is drawn
    Then the "{play} Play" button is wider than the "Play" button by 12 to 30 pixels
    And the "{play}" button is narrower than the "Play" button

  Scenario: Fill and bold weights are heavier than regular
    Given buttons labelled "{play}", "{play:bold}", "{play:fill}", "{record}", "{record:fill}"
    When a frame is drawn
    Then the "{play:fill}" button has at least 1.4 times the ink of the "{play}" button
    And the "{play:bold}" button has at least 1.15 times the ink of the "{play}" button
    And the "{record:fill}" button has at least 1.4 times the ink of the "{record}" button
    And I save the picture "icon-weights"

  Scenario: The icon sits on the text's vertical centre
    Given buttons labelled "{play} ELM", "{stop} ELM", "{speaker-high} ELM", "{trash:fill} ELM"
    When a frame is drawn
    Then in every button the icon's centre is within 1.5 pixels of the capitals' centre
    And I save the picture "icon-alignment"

  Scenario: The icons the DAW uses all draw in every weight
    Given buttons labelled "{play}", "{pause}", "{stop}", "{record}", "{skip-back}", "{speaker-high}", "{waveform}", "{metronome}", "{music-notes}", "{sliders-horizontal}", "{folder-open}", "{floppy-disk}", "{download-simple}", "{trash}", "{plus}", "{minus}", "{x}", "{gear}", "{copy}", "{arrow-counter-clockwise}"
    When a frame is drawn
    Then every button has ink
    And I save the picture "icons-daw-regular"

  Scenario: The DAW icons in fill
    Given buttons labelled "{play:fill}", "{pause:fill}", "{stop:fill}", "{record:fill}", "{skip-back:fill}", "{speaker-high:fill}", "{waveform:fill}", "{metronome:fill}", "{music-notes:fill}", "{sliders-horizontal:fill}", "{folder-open:fill}", "{floppy-disk:fill}", "{download-simple:fill}", "{trash:fill}", "{plus:fill}", "{minus:fill}", "{x:fill}", "{gear:fill}", "{copy:fill}", "{arrow-counter-clockwise:fill}"
    When a frame is drawn
    Then every button has ink
    And I save the picture "icons-daw-fill"

  Scenario: Icon and label tabs fit the Canvas Surfaces sidebar
    Given a tab bar with the tabs "{gear} Tool, {music-notes} Surfaces, {waveform} Animate, {floppy-disk} Scene" in a 330 pixel column
    When a frame is drawn
    Then every tab is on the same line
    And every tab has ink
    And I save the picture "icons-tabs"

  Scenario: Icon-only tabs fit a column far too narrow for their labels
    Given a tab bar with the tabs "{gear}, {music-notes}, {waveform}, {floppy-disk}, {question}" in a 200 pixel column
    When a frame is drawn
    Then every tab is on the same line
    And every tab has ink
    And I save the picture "icons-tabs-compact"
