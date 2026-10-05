// The founding mission: the guided opening of every campaign. A small regime outpost stands near
// your hometown. Lead your five comrades there (on foot or by flying car), clear its garrison,
// and raise your flag in its courtyard: it becomes the party's headquarters, marked in the sky,
// on the mini map and on the world map.

import { regionDefById } from "./al_data";
import { type Campaign, type CompoundState, type MissionState, EARTH_RADIUS_KM, angularDistance, pushNews } from "./al_state";
import { outpostPlan } from "./al_military";
import { gainXp } from "./al_party";

/** Meters from the outpost at which the approach becomes the assault. */
export const ASSAULT_RANGE = 140;
export const MISSION_REWARD = 1500;

/** Starts the founding mission at the party's hometown: places the outpost near the start. */
export function startFoundingMission(c: Campaign): MissionState {
    const outpost = outpostPlan(c.party.hq, c.player.lat, c.player.lon);
    (c.compounds ??= {})[outpost.id] = outpost;
    c.mission = { id: "founding", step: "approach", compound: outpost.id, startedDay: c.day, raise: 0 };
    pushNews(c, `Comrades report a lightly held regime outpost outside ${regionDefById(c.party.hq)?.name ?? "town"}. Take it for the party.`, "info");
    return c.mission;
}

export function missionCompound(c: Campaign): CompoundState | null {
    const m = c.mission;
    return m ? c.compounds?.[m.compound] ?? null : null;
}

/** Meters from you to the mission's target. */
export function missionDistance(c: Campaign): number {
    const cs = missionCompound(c);
    return cs ? angularDistance(c.player.lat, c.player.lon, cs.lat, cs.lon) * EARTH_RADIUS_KM * 1000 : Infinity;
}

/** The HUD's objective line while the mission runs (null once it is done). */
export function missionObjective(c: Campaign): string | null {
    const m = c.mission, cs = missionCompound(c);
    if (!m || !cs || m.step === "done") return null;
    const d = missionDistance(c);
    const far = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
    switch (m.step) {
        case "assemble":
        case "approach": return `FOUNDING: Lead your 5 comrades to the regime outpost (${far}, gold marker). Fly there or walk.`;
        case "assault": return `FOUNDING: Storm the outpost - ${cs.garrison} defender${cs.garrison === 1 ? "" : "s"} left. Civilians are never targets.`;
        case "raise": return `FOUNDING: Raise the party flag - stand at the flagpole in the courtyard.`;
    }
}

/**
 * Advances the mission from the compound's state and your distance to it. Returns a line to
 * announce when a step changes, or null.
 */
export function updateMission(c: Campaign): string | null {
    const m = c.mission, cs = missionCompound(c);
    if (!m || !cs || m.step === "done") return null;
    const d = missionDistance(c);
    if (cs.captured) return completeMission(c);
    if ((m.step === "approach" || m.step === "assemble") && d < ASSAULT_RANGE) { m.step = "assault"; return "The outpost's guards have seen you. Take it!"; }
    if (m.step === "assault" && cs.garrison <= 0) { m.step = "raise"; return "The outpost is clear. Raise the flag in the courtyard!"; }
    return null;
}

/** The outpost is yours: it becomes party headquarters. */
export function completeMission(c: Campaign): string {
    const m = c.mission!, cs = missionCompound(c)!;
    m.step = "done";
    cs.captured = true; cs.garrison = 0;
    const name = `${regionDefById(cs.settlement)?.name ?? "Party"} HQ`;
    c.party.hqSite = { lat: cs.lat, lon: cs.lon, name };
    c.party.funds += MISSION_REWARD;
    gainXp(c, 200);
    pushNews(c, `${c.party.name} seizes the regime outpost. ${name} is founded!`, "good");
    return `${name} is yours: headquarters, quartermaster and safehouse. +CR ${MISSION_REWARD}.`;
}
