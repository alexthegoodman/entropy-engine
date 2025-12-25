fn on_update(player, state) {
    let weapon_id = player.get_equipped_weapon_id();
    
    // Check if Fire Staff is equipped (case insensitive-ish check)
    if weapon_id.contains("FireStaff") || weapon_id.contains("fire_staff") {
        if !state.contains("fire_rain_active") {
            let pos = player.get_position();
            
            // Spawn fire rain system above the player
            // position, color (RGBA), gravity
            system.spawn_particles(
                new_vector3(pos.x, pos.y + 15.0, pos.z), 
                [1.0, 0.3, 0.0, 1.0], 
                new_vector3(0.0, -10.0, 0.0)
            );
            
            state["fire_rain_active"] = "true";
            print("Fire Staff activated! Calling fire from the heavens...");
        }
    } else {
        if state.contains("fire_rain_active") {
            state.remove("fire_rain_active");
            print("Fire Staff unequipped.");
        }
    }
    
    return state;
}
