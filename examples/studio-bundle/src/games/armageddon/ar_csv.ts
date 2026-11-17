// The design database as CSV text: the v0.1 columns (docs/armageddon/v0.1) with every TBD filled
// from ar_data.ts. Pure, so tests can check it; tools/ar_export_csv.ts writes the files.
import type * as D from "./ar_data";

type Data = {
    AMMO: D.Ammo[]; ARMOR: D.Armor[]; ATTACHMENTS: D.Attachment[]; BALANCE: typeof D.BALANCE; EQUIPMENT: D.Equipment[];
    MECHA: D.Mecha[]; REWARDS: D.Reward[]; SQUADS: D.Squad[]; VEHICLES: D.Vehicle[]; WEAPONS: D.Weapon[]; WIR_MODULES: D.WirModule[];
};

const cell = (v: unknown): string => {
    const s = typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const table = (head: string[], rows: unknown[][]) => "﻿" + [head, ...rows].map(r => r.map(cell).join(",")).join("\n") + "\n";
const pct = (v: number) => `${Math.round(v * 100)}%`;
const mult = (v: number) => (v === 1 ? "x1.00" : `x${v.toFixed(2)}`);

export function csvTables(d: Data): Record<string, string> {
    const t: Record<string, string> = {};
    t["Weapons.csv"] = table(
        ["Weapon_ID", "Name", "Category", "Slot", "Damage_Type", "Damage", "Effective_Range_m", "Rate_of_Fire_RPM", "Magazine_Capacity", "Reload_Time_s", "Recoil_Profile", "Weight_kg", "Description", "Status"],
        d.WEAPONS.map(w => [w.id, w.name, w.category, w.slot, w.damageType,
            (w.pellets > 1 ? `${w.damage}x${w.pellets} pellets` : `${w.damage}`) + (w.minDamage !== w.damage ? ` (${w.minDamage} at range)` : "") + (w.vsVehicle ? `; ${w.vsVehicle} vs vehicles` : ""),
            w.range, w.rpm, w.mag, w.reload, `${w.recoilWord} (${w.recoil} deg/shot)`, w.weight, w.description, w.status]),
    );
    t["Attachments.csv"] = table(
        ["Attachment_ID", "Name", "Slot_Type", "Compatibility", "Weight_kg", "Aim_Time_Modifier", "Recoil_Modifier", "Description", "Status"],
        d.ATTACHMENTS.map(a => [a.id, a.name, a.slot, `${a.compatibility} (${a.fits.join(" ")})`, a.weight, mult(a.aimTime), mult(a.recoil), a.description + (a.zoom > 1 ? ` Zoom ${a.zoom}x.` : "") + (a.range !== 1 ? ` Range ${mult(a.range)}.` : "") + (a.signature !== 1 ? ` Shot signature ${mult(a.signature)}.` : "") + (a.mag !== 1 ? ` Magazine ${mult(a.mag)}.` : ""), a.status]),
    );
    t["Armor.csv"] = table(
        ["Armor_ID", "Name", "Component_Slot", "Armor_Class", "Weight_kg", "Ballistic_Protection", "Explosive_Protection", "Visual_Signature", "Thermal_Signature", "Noise_Modifier", "Description", "Status"],
        d.ARMOR.map(a => [a.id, a.name, a.slot, a.armorClass, a.weight, pct(a.ballistic), pct(a.explosive), mult(a.visual), mult(a.thermal), mult(a.noise), a.description + (a.offsets ? ` Carries ${a.offsets} kg of load.` : "") + (a.inventory ? ` ${a.inventory} inventory points.` : ""), a.status]),
    );
    t["Ammunition.csv"] = table(
        ["Ammo_ID", "Name", "Ammo_Type", "Damage_Modifier", "Penetration", "Description", "Status"],
        d.AMMO.map(a => [a.id, a.name, a.type, mult(a.damage) + (a.vsArmor !== 1 ? ` (x${a.vsArmor} vs armor)` : ""), pct(a.penetration), a.description + (a.signature !== 1 ? ` Shot signature ${mult(a.signature)}.` : "") + (a.range !== 1 ? ` Range ${mult(a.range)}.` : ""), a.status]),
    );
    t["Equipment.csv"] = table(
        ["Equipment_ID", "Name", "Category", "Deployment_Type", "Weight_kg", "Inventory_Cost", "Description", "Status"],
        d.EQUIPMENT.map(e => [e.id, e.name, e.category, e.deployment, e.weight, `${e.cost} pt (${e.uses} carried)`, `${e.description}.` + (e.effect ? ` Effect ${e.effect}.` : "") + (e.radius ? ` Radius ${e.radius} m.` : "") + (e.duration ? ` ${e.duration} s.` : "") + (e.hp > 1 ? ` ${e.hp} HP.` : ""), e.status]),
    );
    t["Vehicles.csv"] = table(
        ["Vehicle_ID", "Name", "Domain", "Passenger_or_Crew_Capacity", "Primary_Role", "Size_Class", "Health", "Armor", "Top_Speed_kmh", "Armament", "Fuel_or_Energy_Capacity", "Description", "Status"],
        d.VEHICLES.map(v => [v.id, v.name, v.domain, v.seatsLabel, v.role, v.size, v.hp, `${pct(v.armor)} small arms / ${pct(v.explosiveArmor)} explosive`, v.topSpeed, v.armament, v.energy, `${v.description}. Up to ${v.perTeam} per team, respawn ${v.respawn} s.`, v.status]),
    );
    t["Mecha.csv"] = table(
        ["Mecha_ID", "Name", "Role", "Weight_t", "Armor", "Mobility", "Primary_Weapons", "Secondary_Weapons", "Power_Source", "Special_Systems", "Description", "Status"],
        d.MECHA.map(m => [m.id, m.name, m.role, m.weight, `${m.parts.legs + m.parts.left + m.parts.right + m.parts.torso} HP (legs ${m.parts.legs}, arms ${m.parts.left}/${m.parts.right}, torso ${m.parts.torso}); ${pct(m.armor)} small arms`, `${m.topSpeed} km/h`, m.primary, m.secondary, m.power, m.special, `${m.description}. One mecha per side at a time.`, m.status]),
    );
    t["Rewards.csv"] = table(
        ["Reward_ID", "Name", "Reward_Type", "Proposed_Requirement", "Effect", "Payload_or_Uses", "Cooldown_s", "Counterplay_or_Notes", "Status"],
        d.REWARDS.map(r => [r.id, r.name, r.type, r.type === "Killstreak" ? r.requirement : `${r.requirement} s in the bottom ${pct(d.BALANCE.underdogShare)} of the team leaderboard`, r.effect, r.payload, r.cooldown, r.counterplay, r.status]),
    );
    t["Squads.csv"] = table(
        ["Squad_ID", "Name", "Squad_Size", "Organization", "Primary_Role", "Available_Commands", "Behavior_Notes", "Status"],
        d.SQUADS.map(s => [s.id, s.name, s.size, `${s.organization} [${s.roles.join(", ")}]`, s.primaryRole, s.commands, s.notes, s.status]),
    );
    t["WIR_Behaviors.csv"] = table(
        ["Behavior_ID", "WIR_Module", "Layer", "Applies_To", "Responsibilities", "Inputs", "Behavior_Design_Notes", "Status"],
        d.WIR_MODULES.map(m => [m.id, m.module, m.layer, m.appliesTo, m.responsibilities, m.inputs, `${m.notes}. Network: ${m.network}`, m.status]),
    );
    t["Balance_Scale.csv"] = table(["Quantity", "Value", "Notes"], [
        ["Soldier health", d.BALANCE.soldierHp, "HP; vehicles and mecha use the same HP"],
        ["Free load", d.BALANCE.freeLoad, "kg carried before speed drops"],
        ["Full-penalty load", d.BALANCE.maxLoad, `kg at which speed is ${pct(d.BALANCE.minSpeedShare)}`],
        ["Walk / run / sprint", `${d.BALANCE.walk} / ${d.BALANCE.run} / ${d.BALANCE.sprint}`, "m/s"],
        ["Crouch / prone", `${d.BALANCE.crouch} / ${d.BALANCE.prone}`, "m/s"],
        ["Hit locations", `head ${pct(d.BALANCE.head.share)} x${d.BALANCE.head.mult}; torso ${pct(d.BALANCE.torso.share)}; arms ${pct(d.BALANCE.arms.share)} x${d.BALANCE.arms.mult}; legs ${pct(d.BALANCE.legs.share)} x${d.BALANCE.legs.mult}`, "share of hits and damage multiplier"],
        ["Damage falloff", "full to 25% of range, linear to minimum at range, zero at 2x range", ""],
        ["Armor", "damage x (1 - protection x (1 - penetration))", "protection capped at 80% per location"],
        ["Sight range", d.BALANCE.sightRange, "m for a standing, moving soldier with signature 1"],
        ["Respawn", d.BALANCE.respawn, "s (Conquer: everyone respawns within 5 s)"],
        ["Capture", d.BALANCE.capture, "s for one soldier; more soldiers capture faster (sqrt)"],
        ["Tickets", d.BALANCE.tickets, "per team; a death costs 1"],
        ["Territory drain", d.BALANCE.drain, "tickets per extra territory held, per 10 s"],
        ["Underdog", `${d.BALANCE.underdogSeconds} s in the bottom ${pct(d.BALANCE.underdogShare)}`, "earns one underdog reward"],
        ["Teams", `${d.BALANCE.teamSize} vs ${d.BALANCE.teamSize}`, `${d.BALANCE.teamSize / d.BALANCE.squadSize} squads of ${d.BALANCE.squadSize} per side`],
    ]);
    return t;
}
