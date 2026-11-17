// Writes Armageddon 2070's Design Database v0.2 (docs/armageddon/v0.2/*.csv) from the game data in
// src/games/armageddon/ar_data.ts: the v0.1 columns with every TBD filled, plus Balance_Scale.csv.
//   deno run -A --unstable-sloppy-imports tools/ar_export_csv.ts
import { AMMO, ARMOR, ATTACHMENTS, BALANCE, EQUIPMENT, MECHA, REWARDS, SQUADS, VEHICLES, WEAPONS, WIR_MODULES } from "../src/games/armageddon/ar_data.ts";
import { csvTables } from "../src/games/armageddon/ar_csv.ts";

const out = new URL("../../../docs/armageddon/v0.2/", import.meta.url);
Deno.mkdirSync(out, { recursive: true });
const tables = csvTables({ AMMO, ARMOR, ATTACHMENTS, BALANCE, EQUIPMENT, MECHA, REWARDS, SQUADS, VEHICLES, WEAPONS, WIR_MODULES });
for (const [name, text] of Object.entries(tables)) {
    Deno.writeTextFileSync(new URL(name, out), text);
    console.log(`${name}: ${text.split("\n").length - 2} rows`);
}
