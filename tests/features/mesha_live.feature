Feature: Mesha in the real window
  Mesha opens on a procedural office chair. Variation explores sensible designs while locked
  controls stay put, the library adds more objects that compose into a scene, switching the base
  swaps wheels for legs, and the scene exports as ordinary GLB geometry. Screenshots of the
  composed frame (3D viewport and panels) are kept for visual verification.

  Background:
    Given the real Mesha app is running in test mode

  Scenario: The first object
    When I advance 30 frames
    Then I see the label "Add object"
    And I see the label "Scene"
    And I see the label "Zoom"
    And I capture "01-office-chair"

  Scenario: Variation keeps what is locked
    When I call the tool "mesha_lock" with {"keys": ["seatHeight", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.8, "seed": 3}
    And I advance 6 frames
    Then I capture "02-variation"
    When I click "mesha-vary"
    And I advance 6 frames
    Then I capture "03-variation-from-the-button"
    And I call the tool "mesha_state"

  Scenario: Four legs instead of wheels
    When I call the tool "mesha_set" with {"values": {"base": "legs", "legStyle": "tapered", "baseFinish": "wood.walnut", "headrest": false, "backHeight": 0.45}}
    And I advance 6 frames
    Then I capture "04-four-legs"
    And I call the tool "mesha_describe" with {"objectId": "furniture.office_chair"}

  Scenario: Composing a scene
    When I call the tool "mesha_add" with {"objectId": "furniture.table", "preset": "Bistro round", "position": [1.1, 0, 0]}
    And I call the tool "mesha_add" with {"objectId": "household.bottle", "preset": "Bordeaux", "position": [1.05, 0.74, 0.08]}
    And I call the tool "mesha_add" with {"objectId": "nature.rock", "preset": "River stones", "position": [-0.9, 0, 0.6]}
    And I call the tool "mesha_view" with {"all": true, "yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "05-scene"
    When I call the tool "mesha_view" with {"lighting": "warm"}
    And I advance 4 frames
    Then I capture "06-warm-evening"

  Scenario: Undo and export
    When I call the tool "mesha_undo"
    And I call the tool "mesha_undo" with {"redo": true}
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-live-export.glb"}
    And I call the tool "mesha_state"

  Scenario: Window count 4 to 6 on a composed facade
    When I call the tool "mesha_add" with {"objectId": "architecture.facade", "values": {"windowCount": 4}, "position": [0, 0, -4]}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 12}
    And I advance 8 frames
    Then I capture "07-facade-four-windows"
    When I call the tool "mesha_set" with {"values": {"windowCount": 6}}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 12}
    And I advance 8 frames
    Then I capture "08-facade-six-windows"

  Scenario: A sculptural lamp can be customized and varied with its finishes locked
    When I call the tool "mesha_add" with {"objectId": "household.table_lamp", "preset": "Stoneware linen", "position": [5, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18, "lighting": "studio"}
    And I advance 8 frames
    Then I capture "09-lamp-stoneware"
    When I call the tool "mesha_set" with {"values": {"height": 0.34, "shadeRadius": 0.16, "shadeShape": "dome", "shadeShare": 0.32, "baseShape": "column", "baseWidth": 0.4, "baseShare": 0.9, "shadeFinish": "paint.sage", "baseFinish": "paint.sage", "rim": false}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "10-lamp-mushroom"
    When I call the tool "mesha_lock" with {"keys": ["height", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.8, "seed": 12}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "11-lamp-variation"
    When I call the tool "mesha_add" with {"objectId": "household.table_lamp", "preset": "Walnut reading", "position": [7, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 28}
    And I advance 8 frames
    Then I capture "12-lamp-walnut"
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-lamps-export.glb"}

  Scenario: Coffee maker presets and constrained customization
    When I call the tool "mesha_add" with {"objectId": "household.coffee_maker", "preset": "Sage barista", "position": [12, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 20, "lighting": "studio"}
    And I advance 8 frames
    Then I capture "13-coffee-sage"
    When I call the tool "mesha_add" with {"objectId": "household.coffee_maker", "preset": "Cafe twin", "position": [14, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 20}
    And I advance 8 frames
    Then I capture "14-coffee-cafe"
    When I call the tool "mesha_set" with {"values": {"width": 0.22, "groups": 2, "bodyFinish": "paint.navy", "gauges": false, "cupRail": false, "buttons": 1}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 20}
    And I advance 8 frames
    Then I capture "15-coffee-compact"
    When I call the tool "mesha_lock" with {"keys": ["group:size", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.8, "seed": 7}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 20}
    And I advance 8 frames
    Then I capture "16-coffee-variation"
    When I call the tool "mesha_add" with {"objectId": "household.coffee_maker", "preset": "Cream and walnut", "position": [16, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 20}
    And I advance 8 frames
    Then I capture "17-coffee-cream"
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-coffee-export.glb"}

  Scenario: A hollow dome has an entrance and an inspectable interior
    When I call the tool "mesha_add" with {"objectId": "architecture.dome_building", "preset": "Civic rotunda", "position": [45, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 18, "lighting": "studio"}
    And I advance 8 frames
    Then I capture "18-dome-civic"
    When I call the tool "mesha_set" with {"values": {"roofVisible": false}}
    And I call the tool "mesha_view" with {"yaw": 15, "pitch": 55}
    And I advance 8 frames
    Then I capture "19-dome-empty-interior"
    When I call the tool "mesha_set" with {"values": {"roofVisible": true, "doorWidth": 4, "doorHeight": 3.2}}
    And I call the tool "mesha_view" with {"yaw": 0, "pitch": 8}
    And I advance 8 frames
    Then I capture "20-dome-entrance"
    When I call the tool "mesha_add" with {"objectId": "architecture.dome_building", "preset": "Alien seed vault", "position": [70, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 24}
    And I advance 8 frames
    Then I capture "21-dome-alien"
    When I call the tool "mesha_lock" with {"keys": ["group:entry", "group:size", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.7, "seed": 9}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 24}
    And I advance 8 frames
    Then I capture "22-dome-variation"
    When I call the tool "mesha_add" with {"objectId": "architecture.dome_building", "preset": "Senate hall", "position": [100, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 18}
    And I advance 8 frames
    Then I capture "23-dome-senate"
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-dome-export.glb"}

  Scenario: A house with rooms and staircases you can look into
    When I call the tool "mesha_add" with {"objectId": "architecture.house", "preset": "Brick colonial", "position": [135, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 16, "lighting": "studio"}
    And I advance 8 frames
    Then I capture "24-house-colonial"
    When I call the tool "mesha_set" with {"values": {"roofVisible": false}}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 60}
    And I advance 8 frames
    Then I capture "25-house-top-storey"
    When I call the tool "mesha_set" with {"values": {"cutaway": 1}}
    And I call the tool "mesha_view" with {"yaw": 200, "pitch": 50}
    And I advance 8 frames
    Then I capture "26-house-ground-floor"
    When I call the tool "mesha_set" with {"values": {"roofVisible": true, "cutaway": 0, "storeys": 3, "width": 13, "depth": 10, "roofStyle": "hip"}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 16}
    And I advance 8 frames
    Then I capture "27-house-three-storeys"
    When I call the tool "mesha_add" with {"objectId": "architecture.house", "preset": "White farmhouse", "position": [160, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 16}
    And I advance 8 frames
    Then I capture "28-house-farmhouse"
    When I call the tool "mesha_lock" with {"keys": ["group:size", "group:plan", "group:stairs", "group:materials", "group:interiorMaterials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.7, "seed": 11}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 16}
    And I advance 8 frames
    Then I capture "29-house-variation"
    When I call the tool "mesha_add" with {"objectId": "architecture.door", "preset": "Georgian fanlight", "position": [180, 0, 0]}
    And I call the tool "mesha_set" with {"values": {"openAngle": 70}}
    And I call the tool "mesha_view" with {"yaw": 35, "pitch": 12}
    And I advance 8 frames
    Then I capture "30-door-open"
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-house-export.glb"}

  Scenario: Broadleaf trees across the seasons, weeping, and varied with their finishes locked
    When I call the tool "mesha_add" with {"objectId": "nature.tree", "preset": "English oak", "position": [220, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 10, "lighting": "daylight"}
    And I advance 10 frames
    Then I capture "31-tree-oak"
    When I call the tool "mesha_add" with {"objectId": "nature.tree", "preset": "Weeping willow", "position": [245, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 10}
    And I advance 10 frames
    Then I capture "32-tree-willow"
    When I call the tool "mesha_add" with {"objectId": "nature.tree", "preset": "Autumn maple", "position": [270, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 210, "pitch": 8, "lighting": "warm"}
    And I advance 10 frames
    Then I capture "33-tree-autumn-backlit"
    When I call the tool "mesha_set" with {"values": {"canopy": "bare"}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 10, "lighting": "daylight"}
    And I advance 10 frames
    Then I capture "34-tree-winter"
    When I call the tool "mesha_set" with {"values": {"canopy": "leaves"}}
    And I call the tool "mesha_lock" with {"keys": ["group:size", "group:materials", "canopy"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.8, "seed": 4}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 10}
    And I advance 10 frames
    Then I capture "35-tree-variation"

  Scenario: Conifers, palms and ferns
    When I call the tool "mesha_add" with {"objectId": "nature.conifer", "preset": "Norway spruce", "position": [300, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 8}
    And I advance 10 frames
    Then I capture "36-conifer-spruce"
    When I call the tool "mesha_set" with {"values": {"foliage": "tiers"}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 8}
    And I advance 8 frames
    Then I capture "37-conifer-tiers"
    When I call the tool "mesha_add" with {"objectId": "nature.conifer", "preset": "Scots pine", "position": [320, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 8}
    And I advance 10 frames
    Then I capture "38-conifer-pine"
    When I call the tool "mesha_add" with {"objectId": "nature.palm", "preset": "Coconut palm", "position": [340, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 10}
    And I advance 8 frames
    Then I capture "39-palm-coconut"
    When I call the tool "mesha_add" with {"objectId": "nature.fern", "preset": "Tree fern", "position": [360, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 12}
    And I advance 8 frames
    Then I capture "40-fern-tree"
    When I call the tool "mesha_add" with {"objectId": "nature.fern", "preset": "Boston fern", "position": [370, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 32}
    And I advance 8 frames
    Then I capture "41-fern-boston"

  Scenario: Shrubs, grasses, flowers and a potted plant
    When I call the tool "mesha_add" with {"objectId": "nature.shrub", "preset": "Clipped hedge", "position": [380, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 16}
    And I advance 8 frames
    Then I capture "42-shrub-hedge"
    When I call the tool "mesha_add" with {"objectId": "nature.shrub", "preset": "Hydrangea", "position": [386, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "43-shrub-hydrangea"
    When I call the tool "mesha_set" with {"values": {"flowerFinish": "flower.pink"}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "44-shrub-hydrangea-pink"
    When I call the tool "mesha_add" with {"objectId": "nature.grass", "preset": "Pampas grass", "position": [392, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 12}
    And I advance 8 frames
    Then I capture "45-grass-pampas"
    When I call the tool "mesha_add" with {"objectId": "nature.grass", "preset": "Lavender", "position": [396, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 20}
    And I advance 8 frames
    Then I capture "46-grass-lavender"
    When I call the tool "mesha_add" with {"objectId": "nature.flowers", "preset": "Red tulips", "position": [400, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 16}
    And I advance 8 frames
    Then I capture "47-flowers-tulips"
    When I call the tool "mesha_add" with {"objectId": "nature.flowers", "preset": "Sunflower", "position": [403, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 60, "pitch": 6}
    And I advance 8 frames
    Then I capture "48-flowers-sunflower"
    When I call the tool "mesha_add" with {"objectId": "household.potted_plant", "preset": "Terracotta fern", "position": [406, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "49-potted-fern"
    When I call the tool "mesha_set" with {"values": {"plant": "succulent", "potShape": "bowl", "potHeight": 0.1, "plantSize": 1.7, "foliage": "leaf.succulent", "saucer": false}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 30}
    And I advance 8 frames
    Then I capture "50-potted-succulent"
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-foliage-export.glb"}

  Scenario: A composed garden
    When I call the tool "mesha_add" with {"objectId": "nature.shrub", "preset": "Clipped hedge", "position": [440, 0, -1.5]}
    And I call the tool "mesha_add" with {"objectId": "nature.shrub", "preset": "Boxwood ball", "position": [437.4, 0, 2.6]}
    And I call the tool "mesha_add" with {"objectId": "nature.flowers", "preset": "Pink cosmos", "position": [441.8, 0, 2.8]}
    And I call the tool "mesha_add" with {"objectId": "nature.grass", "preset": "Lavender", "position": [439.6, 0, 3.4]}
    And I call the tool "mesha_add" with {"objectId": "household.potted_plant", "preset": "Topiary urn", "position": [443.4, 0, 1.6]}
    And I call the tool "mesha_add" with {"objectId": "nature.tree", "values": {"height": 6.5, "seed": 5}, "position": [440, 0, 0]}
    And I call the tool "mesha_view" with {"all": false}
    And I advance 4 frames
    And I call the tool "mesha_view" with {"yaw": 12, "pitch": 9, "lighting": "daylight"}
    And I advance 10 frames
    Then I capture "51-garden"

  Scenario: Interplanetary lodgings with cabins, a spiral stair and an airlock
    When I call the tool "mesha_add" with {"objectId": "architecture.hab_lodge", "preset": "Orbital lodge", "position": [500, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 14, "lighting": "studio"}
    And I advance 8 frames
    Then I capture "52-hab-orbital"
    When I call the tool "mesha_set" with {"values": {"roofVisible": false}}
    And I call the tool "mesha_view" with {"yaw": 200, "pitch": 60}
    And I advance 8 frames
    Then I capture "53-hab-top-deck"
    When I call the tool "mesha_set" with {"values": {"cutaway": 1}}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 55}
    And I advance 8 frames
    Then I capture "54-hab-lower-deck"
    When I call the tool "mesha_add" with {"objectId": "architecture.hab_lodge", "preset": "Mars outpost inn", "position": [540, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 14, "lighting": "warm"}
    And I advance 8 frames
    Then I capture "55-hab-mars"
    When I call the tool "mesha_lock" with {"keys": ["group:size", "group:plan", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.7, "seed": 5}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 14}
    And I advance 8 frames
    Then I capture "56-hab-variation"
    When I call the tool "mesha_add" with {"objectId": "architecture.hab_lodge", "preset": "Luxury star hotel", "position": [580, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 12, "lighting": "night"}
    And I advance 8 frames
    Then I capture "57-hab-luxury-night"

  Scenario: A fortified wasteland depot, wrecked and stripped
    When I call the tool "mesha_add" with {"objectId": "architecture.wasteland_depot", "preset": "Scavenger depot", "position": [640, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 12, "lighting": "warm"}
    And I advance 8 frames
    Then I capture "58-depot-scavenger"
    When I call the tool "mesha_set" with {"values": {"roofVisible": false}}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 58}
    And I advance 8 frames
    Then I capture "59-depot-inside"
    When I call the tool "mesha_set" with {"values": {"roofVisible": true, "rollerOpen": 0, "roofDamage": 0.8}}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 12}
    And I advance 8 frames
    Then I capture "60-depot-shut-and-wrecked"
    When I call the tool "mesha_add" with {"objectId": "architecture.wasteland_depot", "preset": "Abandoned factory", "position": [700, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18, "lighting": "daylight"}
    And I advance 8 frames
    Then I capture "61-depot-factory"
    When I call the tool "mesha_lock" with {"keys": ["group:size", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.8, "seed": 21}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "62-depot-variation"

  Scenario: A crooked magic shop with a tower, crystals and candlelit windows
    When I call the tool "mesha_add" with {"objectId": "architecture.arcane_emporium", "preset": "Twilight emporium", "position": [760, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 12, "lighting": "night"}
    And I advance 8 frames
    Then I capture "63-arcane-twilight"
    When I call the tool "mesha_set" with {"values": {"litWindows": true, "crystals": 9}}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 12}
    And I advance 8 frames
    Then I capture "64-arcane-candlelit"
    When I call the tool "mesha_set" with {"values": {"roofVisible": false}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 60, "lighting": "studio"}
    And I advance 8 frames
    Then I capture "65-arcane-rooms"
    When I call the tool "mesha_set" with {"values": {"cutaway": true}}
    And I call the tool "mesha_view" with {"yaw": 60, "pitch": 55}
    And I advance 8 frames
    Then I capture "66-arcane-shop-and-tower-stair"
    When I call the tool "mesha_add" with {"objectId": "architecture.arcane_emporium", "preset": "Hedge-witch apothecary", "position": [800, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 12, "lighting": "daylight"}
    And I advance 8 frames
    Then I capture "67-arcane-apothecary"
    When I call the tool "mesha_lock" with {"keys": ["group:size", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.7, "seed": 8}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 12}
    And I advance 8 frames
    Then I capture "68-arcane-variation"
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-themed-export.glb"}
