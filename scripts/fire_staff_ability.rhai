fn on_update(player, system, state) {
    let weapon_name = player.get_equipped_weapon_name();
    
    // Check if Fire Staff is equipped
    if weapon_name.contains("Fire Staff") || weapon_name.contains("fire staff") {
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

fn on_attack(player, system, state) {
    let weapon_name = player.get_equipped_weapon_name();
    
    if weapon_name.contains("Fire Staff") || weapon_name.contains("fire staff") {
        let pos = player.get_position();  // Returns [x, y, z]
        print("Attack!");

        // Use arrays throughout
        system.spawn_particles(
            vec3(pos.x, pos.y + 5.0, pos.z), // start pos
            vec4(1.0, 0.3, 0.0, 1.0), // color
            vec3(0.0, -1.0, 0.0), // grav
        );
        
        print("Fire Staff attack!");
    }
    
    return state;
}