fn on_update(player, state) {
    let weapon_id = player.get_equipped_weapon_id();
    
    // Check if Fire Staff is equipped
    if weapon_id.contains("FireStaff") || weapon_id.contains("fire_staff") {
        if !state.contains("fire_staff_equipped") {
            state["fire_staff_equipped"] = "true";
            print("Fire Staff equipped.");
        }
    } else {
        if state.contains("fire_staff_equipped") {
            state.remove("fire_staff_equipped");
            print("Fire Staff unequipped.");
        }
    }
    
    return state;
}

fn on_attack(player, state) {
    let weapon_id = player.get_equipped_weapon_id();
    
    if weapon_id.contains("FireStaff") || weapon_id.contains("fire_staff") {
        let pos = player.get_position();
        
        // Spawn fire rain system above the player
        system.spawn_particles(
            new_vector3(pos.x, pos.y + 15.0, pos.z), 
            [1.0, 0.3, 0.0, 1.0], 
            new_vector3(0.0, -10.0, 0.0)
        );
        
        print("Fire Staff attack! Calling fire from the heavens...");
    }
}