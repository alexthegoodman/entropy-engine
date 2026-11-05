Feature: The Game World Planner in the real window
  (The driver's GUI pointer "move" holds the button down, so plain hovering is sent as "up".)
  The map's tools driven with real pointer input: select and drag a spot (it lands on the ground),
  place a spot, draw a road that snaps to a town, measure between two spots, switch terrain views
  and zoom in on the contours. Then the Codex and Agent tabs, whose multiline text fields used to
  freeze the app, and the terrain tools, whose results land back on the map. In between, design
  intents: an area sketched with the Intent tool and settled by the Planner Agent, a pacing route
  whose proposal is rejected, and a pinned intent answered by an external agent over MCP. Screenshots of every
  step are kept for visual verification. Map geometry assumes the 1800x1020 window and the Shattered
  Isles preset: the 30 km world fits at 26.73 px/km around (730, 558).

  Background:
    Given the real Game World Planner is running in test mode

  Scenario: The map, its terrain views and the overview
    When I advance 30 frames
    Then I see the label "Properties Inspector"
    And I capture "01-relief"
    And I call the tool "game_planner_state"
    When I set "seg_terrain_style" "1"
    And I advance 5 frames
    Then I capture "02-heatmap"
    When I set "seg_terrain_style" "2"
    And I advance 5 frames
    Then I capture "03-slope"
    When I set "seg_terrain_style" "0"
    And I advance 3 frames

  Scenario: Select a spot, then drag it to new ground
    When I send GUI pointer "up" at "663" "505"
    And I advance 2 frames
    And I send GUI pointer "down" at "663" "505"
    And I advance 2 frames
    And I send GUI pointer "up" at "663" "505"
    And I advance 3 frames
    Then I capture "04-selected-spot"
    And I call the tool "game_planner_state"
    When I send GUI pointer "up" at "556" "598"
    And I advance 2 frames
    And I send GUI pointer "down" at "556" "598"
    And I advance 2 frames
    And I send GUI pointer "move" at "580" "620"
    And I advance 2 frames
    And I send GUI pointer "move" at "620" "650"
    And I advance 2 frames
    Then I capture "05-dragging"
    When I send GUI pointer "up" at "620" "650"
    And I advance 3 frames
    And I call the tool "game_planner_state"

  Scenario: Place a spot on the land
    When I click "tool_place_spot"
    And I advance 2 frames
    And I send GUI pointer "up" at "783" "611"
    And I advance 2 frames
    And I send GUI pointer "down" at "783" "611"
    And I advance 2 frames
    And I send GUI pointer "up" at "783" "611"
    And I advance 3 frames
    Then I capture "06-placed-spot"
    And I call the tool "game_planner_state"

  Scenario: Draw a road ending at a town
    When I click "tool_draw_path"
    And I set "dropdown_pending_path_type" "1"
    And I advance 2 frames
    And I send GUI pointer "up" at "703" "585"
    And I advance 2 frames
    And I send GUI pointer "down" at "703" "585"
    And I advance 2 frames
    And I send GUI pointer "up" at "703" "585"
    And I advance 8 frames
    And I send GUI pointer "up" at "783" "660"
    And I advance 2 frames
    And I send GUI pointer "down" at "783" "660"
    And I advance 2 frames
    And I send GUI pointer "up" at "783" "660"
    And I advance 8 frames
    And I send GUI pointer "up" at "955" "716"
    And I advance 3 frames
    Then I capture "07-drawing-road"
    When I send GUI pointer "down" at "955" "716"
    And I advance 2 frames
    And I send GUI pointer "up" at "955" "716"
    And I advance 3 frames
    And I call the tool "game_planner_state"
    When I click "btn_finish_path"
    And I advance 3 frames
    Then I capture "08-road-done"
    And I call the tool "game_planner_state"

  Scenario: Measure from the capital to Drake Peak
    When I click "tool_measure"
    And I advance 2 frames
    And I send GUI pointer "up" at "731" "385"
    And I advance 2 frames
    And I send GUI pointer "down" at "731" "385"
    And I advance 2 frames
    And I send GUI pointer "up" at "731" "385"
    And I advance 3 frames
    And I send GUI pointer "up" at "900" "560"
    And I advance 3 frames
    Then I capture "09-measuring"
    When I send GUI pointer "up" at "956" "717"
    And I advance 2 frames
    And I send GUI pointer "down" at "956" "717"
    And I advance 2 frames
    And I send GUI pointer "up" at "956" "717"
    And I advance 3 frames
    Then I capture "10-measured"
    And I call the tool "game_planner_state"

  Scenario: Zoom in on the contours
    When I click "tool_select"
    And I advance 2 frames
    And I send GUI pointer "up" at "1433" "197"
    And I advance 2 frames
    And I send GUI pointer "down" at "1433" "197"
    And I advance 2 frames
    And I send GUI pointer "up" at "1433" "197"
    And I advance 2 frames
    And I send GUI pointer "down" at "1433" "197"
    And I advance 2 frames
    And I send GUI pointer "up" at "1433" "197"
    And I advance 2 frames
    And I send GUI pointer "up" at "900" "700"
    And I advance 3 frames
    Then I capture "11-zoomed-contours"
    When I click "btn_fit_world"
    And I advance 3 frames

  Scenario: Sketch an intent area and let the Planner Agent settle it
    When I click "tool_intent"
    And I set "seg_intent_shape" "1"
    And I advance 2 frames
    And I send GUI pointer "up" at "530" "420"
    And I advance 2 frames
    And I send GUI pointer "down" at "530" "420"
    And I advance 2 frames
    And I send GUI pointer "up" at "530" "420"
    And I advance 8 frames
    And I send GUI pointer "up" at "600" "405"
    And I advance 2 frames
    And I send GUI pointer "down" at "600" "405"
    And I advance 2 frames
    And I send GUI pointer "up" at "600" "405"
    And I advance 8 frames
    And I send GUI pointer "up" at "665" "425"
    And I advance 2 frames
    And I send GUI pointer "down" at "665" "425"
    And I advance 2 frames
    And I send GUI pointer "up" at "665" "425"
    And I advance 8 frames
    And I send GUI pointer "up" at "660" "488"
    And I advance 2 frames
    And I send GUI pointer "down" at "660" "488"
    And I advance 2 frames
    And I send GUI pointer "up" at "660" "488"
    And I advance 8 frames
    And I send GUI pointer "up" at "560" "492"
    And I advance 3 frames
    Then I capture "intent-01-sketching"
    When I send GUI pointer "down" at "560" "492"
    And I advance 2 frames
    And I send GUI pointer "up" at "560" "492"
    And I advance 3 frames
    And I click "btn_finish_intent"
    And I advance 3 frames
    And I set "edit_intent_title" "The Western Farmlands"
    And I set "edit_intent_directive" "two quiet farming villages by fresh water"
    And I advance 3 frames
    Then I see the label "0 of 2 villages"
    And I capture "intent-02-sketched"
    When I click "btn_draft_intent"
    And I advance 5 frames
    Then I capture "intent-03-proposed"
    When I click "btn_accept_all_0"
    And I advance 5 frames
    Then I see the label "2 of 2 villages"
    And I capture "intent-04-accepted"
    And I call the tool "game_planner_state"

  Scenario: A journey that should take four hours on foot
    When I set "seg_intent_shape" "2"
    And I advance 2 frames
    And I send GUI pointer "up" at "904" "419"
    And I advance 2 frames
    And I send GUI pointer "down" at "904" "419"
    And I advance 2 frames
    And I send GUI pointer "up" at "904" "419"
    And I advance 8 frames
    And I send GUI pointer "up" at "957" "718"
    And I advance 2 frames
    And I send GUI pointer "down" at "957" "718"
    And I advance 2 frames
    And I send GUI pointer "up" at "957" "718"
    And I advance 3 frames
    And I set "edit_intent_minutes" "240"
    And I advance 3 frames
    And I click "btn_draft_intent"
    And I advance 5 frames
    Then I capture "intent-05-pacing-proposed"
    And I call the tool "game_planner_state"
    When I click "btn_reject_all_1"
    And I advance 3 frames

  Scenario: An external agent answers a pinned intent over MCP
    When I set "seg_intent_shape" "0"
    And I advance 2 frames
    And I send GUI pointer "up" at "783" "799"
    And I advance 2 frames
    And I send GUI pointer "down" at "783" "799"
    And I advance 2 frames
    And I send GUI pointer "up" at "783" "799"
    And I advance 3 frames
    And I set "edit_intent_title" "The Drowned Bell"
    And I set "edit_intent_directive" "a ruined bell tower the tide reaches at night"
    And I click "tool_select"
    And I advance 3 frames
    And I call the tool "game_planner_list_intents"
    And I call the tool "game_planner_claim_intent" with {"intentNumber": 3, "agentName": "Claude"}
    And I call the tool "game_planner_propose_revision" with {"agentName": "Claude", "motivation": "A drowned bell tower on the southern shore.", "intentNumber": 3, "changes": [{"changeType": "add_spot", "after": {"name": "The Drowned Bell", "spotType": "ruin", "x": 2.1, "y": -9.1, "description": "A bell tower half-sunk in the tidal flats."}}, {"changeType": "add_codex", "after": {"name": "The Bell-Keeper", "category": "character", "subtitle": "Last of the tower's wardens"}}, {"changeType": "teleport_spot"}]}
    And I advance 5 frames
    Then I capture "intent-06-external-proposal"
    When I click "nav_tab_agent"
    And I advance 5 frames
    Then I see the label "Agents: your intents in, proposals out"
    And I capture "intent-07-agent-inbox"
    When I click "btn_accept_all_2"
    And I advance 3 frames
    And I call the tool "game_planner_state"
    When I click "nav_tab_map"
    And I advance 5 frames
    Then I capture "intent-08-plan"

  Scenario: Codex and Agent tabs no longer freeze
    When I click "nav_tab_codex"
    And I advance 5 frames
    And I click "codex_item_codex_valerius"
    And I advance 5 frames
    And I set "edit_codex_desc" "The stoic ruler of Solaris Citadel."
    And I advance 3 frames
    And I click "btn_regen_codex_prompt"
    And I advance 5 frames
    Then I see the label "Attributes & Stat Block"
    And I capture "12-codex-entry"
    When I click "nav_tab_agent"
    And I advance 5 frames
    Then I see the label "System Prompts for AI Game Masters & Roleplay Agents"
    And I capture "13-agent"

  Scenario: Terrain tools land back on the map
    When I click "nav_tab_procedural"
    And I advance 5 frames
    And I click "btn_simulate_erosion"
    And I advance 3 frames
    And I click "btn_generate_rivers"
    And I advance 3 frames
    And I click "btn_generate_settlements"
    And I advance 3 frames
    And I click "btn_scatter_pois"
    And I advance 3 frames
    Then I capture "14-procedural"
    And I call the tool "game_planner_state"
    When I click "nav_tab_map"
    And I advance 10 frames
    Then I capture "15-generated-world"
    When I set "dropdown_presets" "2"
    And I advance 15 frames
    Then I capture "16-crimson-expanse"
    And I call the tool "game_planner_state"
