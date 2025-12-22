// scripts/test_component.rhai

fn on_update(component, script_state) {
    // Get/set script-specific state
    let update_count = script_state["update_count"];
    if type_of(update_count) == "()" {
        update_count = 0;
    } else {
        update_count = update_count.as_int();
    }
    update_count += 1;
    script_state["update_count"] = update_count;

    // Just mutate the component directly!
    let current_pos = component.position;
    let new_x = current_pos.x + 0.01;
    component.set_position([new_x, current_pos.y, current_pos.z]);

    if update_count % 60 == 0 {
        print(`Component ${component.id}: Pos=[${new_x}, ${current_pos.y}, ${current_pos.z}], Updates=${update_count}`);
    }

    // Just return the updated script_state
    return script_state;
}

fn on_start(component, script_state) {
    print(`Component ${component.id} started!`);
    script_state["update_count"] = 0;
    return script_state;
}