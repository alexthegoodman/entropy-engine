# Yumon AI System TODOs

- Need to capture triggers as the action_taken rather than MoveForward, MoveBackward, or Idle - if that trigger is made within that ~500ms timeframe, otherwise default to one of MoveForward, MoveBackward, or Idle
- Create a training scenario with one main enemy who has very high health, this will simulate the NPC targeting only one enemy (the player) during recreation (see fps_rpg for how we do a larger training scenario, we dont need anything more than cubes for cover / obstacles, and slightly hilly landscape will do)
- Need to ensure that all world state and self state is provided both during play session capture (of moments) and during gameplay when infering from the model (SOME state can be left out, we just want more signals than current)
- Double check that rotationDelta is properly applied in onAction(), if not, lets figure out the proper application
