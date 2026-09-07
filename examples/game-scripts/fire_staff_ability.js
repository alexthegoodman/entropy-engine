export function on_update(player, system, state) {
    let weapon_name = player.equipped_weapon_name;
    
    // Check if Fire Staff is equipped
    if (weapon_name.includes("Fire Staff") || weapon_name.includes("fire staff")) {
        if (!state["fire_staff_equipped"]) {
            state["fire_staff_equipped"] = "true";
            println("Fire Staff equipped.");
        }
    } else {
        if (state["fire_staff_equipped"]) {
            delete state["fire_staff_equipped"];
            println("Fire Staff unequipped.");
        }
    }
    
    return state;
}

export function on_attack(player, system, state) {
    let weapon_name = player.equipped_weapon_name;
    
    if (weapon_name.includes("Fire Staff") || weapon_name.includes("fire staff")) {
        let pos = player.position;  // Returns {x, y, z}
        println("Attack!");

        system.spawn_particles(
            vec3(pos.x + 2.0, pos.y + 5.0, pos.z + 2.0), // start pos
            vec4(1.0, 0.3, 0.0, 1.0), // color
            vec3(0.0, 0.0, 0.0), // grav
        );
        
        println("Fire Staff attack!");
    }
    
    return state;
}
