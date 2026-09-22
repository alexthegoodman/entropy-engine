Feature: The knob drags to a new value and shows it as a filled arc

  Each scenario drives the real entropy_gui::Knob through a headless context, one frame at a
  time. A press frame always reports zero drag delta (see entropy_gui::ui::interact); the value
  only moves on the frames after it, measured against the previous frame's pointer position.

  Scenario: Dragging up raises the value
    Given a knob from 0 to 100 starting at 50
    When I press the knob
    And I drag the pointer up 72 points
    And I release the pointer
    Then the value is 90

  Scenario: Dragging down lowers the value
    Given a knob from 0 to 100 starting at 50
    When I press the knob
    And I drag the pointer down 36 points
    And I release the pointer
    Then the value is 30

  Scenario: The value clamps at the maximum instead of going past it
    Given a knob from 0 to 100 starting at 90
    When I press the knob
    And I drag the pointer up 1000 points
    And I release the pointer
    Then the value is 100

  Scenario: The value clamps at the minimum instead of going past it
    Given a knob from 0 to 100 starting at 10
    When I press the knob
    And I drag the pointer down 1000 points
    And I release the pointer
    Then the value is 0

  Scenario: Hovering without pressing never changes the value
    Given a knob from 0 to 100 starting at 50
    When a frame is drawn with the pointer resting on the knob
    Then the value is 50
    And there is no change event

  Scenario: A change event fires only on frames that actually move the value
    Given a knob from 0 to 100 starting at 50
    When I press the knob
    Then there is no change event
    When I drag the pointer up 18 points
    Then there is a change event
    When I release the pointer
    Then there is no change event

  Scenario: The filled arc actually changes the picture, not just the number
    Given a knob from 0 to 100 starting at 0
    When a frame is drawn
    Then I save the picture "knob-empty"
    When the knob is set to 100
    And a frame is drawn
    Then I save the picture "knob-full"
    And "knob-empty" and "knob-full" look different
