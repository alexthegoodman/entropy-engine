Feature: A floating window takes the pointer from everything underneath it

  Each scenario drives real entropy_gui widgets through a headless context, one frame at a time,
  with pointer input built the way the window backend builds it (hover frame, press frame, release
  frame). The base layer is a scrolling pad grid (the widget the DAW's Drum Rack window floats over)
  plus a drag handle at 460,380-540,420. On top of it float real Windows. "Rack" is at 60,20 (300 by
  240) with a button at 180,56-260,84 and a drag handle at 200,150-280,190. Pad 2 lies under Rack.

  Background:
    Given a pad grid under a window "Rack" at 60,20 sized 300 by 240

  Scenario: A pad nothing covers still takes clicks
    When I click the centre of pad 4
    Then the pad events are "Clicked(pad-4)"

  Scenario: A click on a window's own button reaches the button, not the pad under it
    When I click at 200,70
    Then the Rack button was clicked
    And the pad events are ""

  Scenario: A click on the window's body over a pad does not reach the pad
    When I click at 150,60
    Then the pad events are ""
    And the Rack button was not clicked

  Scenario: A click on the title bar over a pad does not reach the pad
    When I click at 150,34
    Then the pad events are ""

  Scenario: The window reports the pointer as over the UI
    When the pointer hovers at 200,70
    Then the pointer is over the UI

  Scenario: The wheel over a window does not scroll the panel beneath it
    When I scroll by -60 at 200,150
    Then the pad grid has moved 0 pixels

  Scenario: The wheel outside the window scrolls the panel
    When I scroll by -60 at 480,300
    Then the pad grid has moved 60 pixels

  Scenario: A drag inside a window still tracks the pointer across the panel beneath it
    When I press at 240,170
    And I drag to 480,60 holding the button
    And I release the button
    Then the Rack handle was dragged by 240,-110

  Scenario: A drag that started on the panel keeps going when it crosses a window
    When I press at 500,400
    And I drag to 200,90 holding the button
    Then the panel handle was dragged by -300,-310
    And the Rack button was not clicked

  Scenario: A drag that started in a window does not hand the held button to the panel when it leaves
    When I press at 240,170
    And I drag to 500,400 holding the button
    Then the panel handle saw no drag
    And the panel sees no pointer and no held button

  Scenario: Of two overlapping windows, only the upper one is clicked in the overlap
    Given a second window "Analyzer" at 200,120 sized 300 by 200
    When I click at 320,210
    Then the Analyzer button was clicked
    And the Rack overlap button was not clicked

  Scenario: The lower window is still clickable where the upper one is not
    Given a second window "Analyzer" at 200,120 sized 300 by 200
    When I click at 200,70
    Then the Rack button was clicked

  Scenario: Closing the window uncovers the pads beneath it
    When I click the close button of the window
    And the pointer hovers at 200,70
    And I click at 200,70
    Then the pad events are "Clicked(pad-2)"
