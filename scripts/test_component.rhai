// scripts/test_component.rhai

fn on_update(component) {
    let pos = component.position;
    pos[0] = pos[0] + 0.01;
    component.set_position(pos);

    let update_count = component.get_script_state("update_count");
    if type_of(update_count) == "()" {
        update_count = 0;
    }
    update_count += 1;
    component.set_script_state("update_count", update_count.to_string());

    if update_count % 60 == 0 {
        print(`Component ID: ${component.id}, Position: ${component.position}, Updates: ${update_count}`);
    }
}

fn on_start(component) {
    print(`Component ID: ${component.id} started!`);
    component.set_script_state("update_count", "0");
}
