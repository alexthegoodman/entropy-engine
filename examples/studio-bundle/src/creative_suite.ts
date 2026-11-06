// Creative Suite: DAW, Guitar Tabs, Mesha, CC Manager, Terminal, Game World Planner and Game World Detailer bundled together into one unified suite.
// Features a Windows 11 style taskbar at the bottom for seamless switching between the apps.
// Standalone example bins (`cargo run --bin example -- daw`, `guitar-tabs`, `mesha`, `cc-manager`, `game-planner`, `game-detailer`)
// continue to run each app independently.

import "./apps/daw_synth_addon";
import "./apps/tabs/tabs_addon";
import "./apps/mesha/mesha_addon";
import "./apps/cc_manager_addon";
import "./apps/terminal_addon";
import "./apps/game_planner/game_planner_addon";
// Mesha models are evaluated in dist/game_detailer_worker.js, which build-creative-suite bundles too.
// The Planner, Mesha and the Detailer share the suite's one data folder, so a world or preset saved in
// one shows up in the others.
import "./apps/game_detailer/game_detailer_addon";

