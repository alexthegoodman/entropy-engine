// The Rhai side of the fidelity check: replaces the prelude's init (files later in the list win).
fn init() {
    G::__V.__hooks = obj(#{ init: list(), update: list(), keyDown: list(), keyUp: list(), mouseDown: list(), mouseUp: list(), mouseMove: list(), mouseWheel: list(), gamepadButton: list(), gamepadAxis: list() });
    G::__V.__tools = obj();
    __module_init();
    let plan = js_json_parse(Entropy::Store::read("plan.json") ?? "");
    let c = newCampaign();
    c.region = plan.region;
    let game = Game__new(c);
    let trace = list();
    let events = 0.0;
    for ph in plan.phases {
        let input = js_merge([G::__V.NO_INPUT, ph.input]);
        for i in 0..ph.frames.to_int() {
            game.Game__step(plan.dt, input);
            events += game.events.length;
        }
        trace.push(game.player.pos[0], game.player.pos[1], game.player.pos[2], game.campaign.mass);
        trace.push(game.player.charge);
    }
    let alive = game.region.creatures.js_filter1(|x| x.alive).length;
    print("FIDELITY " + js_json_stringify(obj(#{ summary: game.Game__summary(), trace: trace, events: events, bodies: game.region.bodies.length, creatures: alive })));
}
fn update(dt) {}
