// scripts/test_component.rhai

fn on_update(component, script_state) {
    let current_pos = component.position;
    
    // Get/set script-specific state
    let update_count = script_state["update_count"];
    if type_of(update_count) == "()" { // Rhai returns () for null/None
        update_count = 0;
    } else {
        update_count = update_count.as_int(); // Cast from Dynamic to int
    }
    update_count += 1;
    script_state["update_count"] = update_count; // Store in the map

    let new_x = current_pos.x + 0.01;
    let new_pos = [new_x, current_pos.y, current_pos.z];

    let commands = [];
    commands.push(Command::SetPosition(#{ component_id: component.id, position: new_pos }));

    if update_count % 60 == 0 {
        print(`Component ID: ${component.id}, Position: ${new_pos}, Updates: ${update_count}`);
    }

    return [commands, script_state]; // Return commands and the updated script_state map
}

fn on_start(component, script_state) {
    print(`Component ID: ${component.id} started!`);
    script_state["update_count"] = 0;
    return [[], script_state]; // Return empty commands and the initialized script_state map
}
