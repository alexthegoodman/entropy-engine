// Chapter One: First Blood - the words and the shots (docs/THE_ABYSS_STORY.md).
//
// Alex arrives at the site of the drilling catastrophe with the first military expedition into
// the Abyss. The fracture reveals a world below far larger and older than the surface imagined.
// Descending, the expedition meets warriors who believe the surface destroyed their sacred source
// of magic on purpose. The battle devastates the expedition. Alex survives - and both sides come
// away sure the other is a dangerous enemy.
//
// Everything here is data: the cast, the three cutscenes (the opening, the contact at the shrine,
// the ending), the radio and SAGE lines the story plays during play, and each phase's objective.

import type { Scene, Subtitle } from "./ab_cinema";
import type { V2, V3 } from "./ab_world";
import { FOB, SHRINE, SETTLEMENT, EVAC_LZ, SOURCE } from "./ab_world";

// --- The cast --------------------------------------------------------------------------------------

export const CAST = {
    alex: "Lt. Alex",
    voss: "Maj. Voss",
    okafor: "Sgt. Okafor",
    sage: "SAGE",
    pilot: "Kilo-Two",
    warden: "The Warden",
} as const;

/** Alex's squad (Kilo-Two), in the order the story lets them fall (Okafor last; BRASK-7 lives). */
export interface SquadMember { name: string; look: string; slot: [number, number]; mortalFrom: Phase | null; callsign: string }

export const SQUAD: SquadMember[] = [
    { name: "Sgt. Okafor", callsign: "OKAFOR", look: "sergeant", slot: [2.5, 3], mortalFrom: null },
    { name: "Cpl. Reyes", callsign: "REYES", look: "trooper-m", slot: [-3, 5], mortalFrom: "evac" },
    { name: "Pvt. Holt", callsign: "HOLT", look: "trooper-m", slot: [4.5, 7], mortalFrom: "ambush" },
    { name: "Pvt. Saarinen", callsign: "SAARINEN", look: "trooper-f", slot: [-5, 8], mortalFrom: "ambush" },
    { name: "Spc. Vey", callsign: "VEY", look: "trooper-m", slot: [1, 10], mortalFrom: "fallback" },
    { name: "Pvt. Ashby", callsign: "ASHBY", look: "trooper-f", slot: [-2, 12], mortalFrom: "evac" },
    { name: "Pvt. Barre", callsign: "BARRE", look: "trooper-m", slot: [5, 12], mortalFrom: "fallback" },
    { name: "BRASK-7", callsign: "BRASK-7", look: "synthetic", slot: [-6, 3], mortalFrom: null },
];

// --- The phases --------------------------------------------------------------------------------------

export type Phase = "title" | "intro" | "ledge" | "descent" | "floor" | "contact" | "ambush" | "fallback" | "evac" | "laststand" | "ending" | "complete"
    /** Chapter Two: its opening, then the open floor. */
    | "aftermath" | "open";

export const PHASES: Phase[] = ["title", "intro", "ledge", "descent", "floor", "contact", "ambush", "fallback", "evac", "laststand", "ending", "complete", "aftermath", "open"];

export interface Objective { title: string; text: string; marker: V2 | null }

/** Where things are in Chapter One (beyond ab_world's landmarks). */
export const PLACES = {
    /** Where Kilo-Two sets down on Ledge Kilo, and where the supply drop and Okafor wait. */
    landing: [-655, -738] as V2,
    supply: [-610, -728] as V2,
    okafor: [-628, -742] as V2,
    /** The top and the foot of the rockslide. */
    rampTop: [-470, -722] as V2,
    rampFoot: [140, -700] as V2,
    /** The crest of the rockslide, top to foot (the squad walks it). */
    rampPath: [[-560, -735], [-470, -722], [-420, -732], [-370, -775], [-270, -775], [-220, -752], [-170, -750], [-120, -775], [-20, -765], [80, -732], [140, -700]] as V2[],
    shrine: SHRINE,
    settlement: SETTLEMENT,
    lz: EVAC_LZ,
    fob: FOB,
};

export const OBJECTIVES: Partial<Record<Phase, Objective[]>> = {
    ledge: [
        { title: "LEDGE KILO", text: "Rally on Sgt. Okafor", marker: PLACES.okafor },
        { title: "LEDGE KILO", text: "Take plates and medgel from the supply drop", marker: PLACES.supply },
    ],
    descent: [{ title: "THE ROCKSLIDE", text: "Descend to the cavern floor", marker: PLACES.rampFoot }],
    floor: [
        { title: "THE FLOOR", text: "Survey the structures", marker: SETTLEMENT },
        { title: "THE FLOOR", text: "Investigate the shrine", marker: SHRINE },
    ],
    ambush: [{ title: "FIRST BLOOD", text: "Survive", marker: null }],
    fallback: [{ title: "FALL BACK", text: "Reach the landing zone", marker: EVAC_LZ }],
    evac: [{ title: "EXTRACTION", text: "Hold the landing zone", marker: EVAC_LZ }],
    laststand: [
        { title: "NO EVAC", text: "Hold on", marker: null },
        { title: "NO EVAC", text: "Drink", marker: null },
    ],
};

// --- Lines during play ---------------------------------------------------------------------------------

export interface Line { speaker: string; text: string; channel: Subtitle["channel"]; delay?: number }

const r = (speaker: string, text: string, delay = 0): Line => ({ speaker, text, channel: "radio", delay });
const s = (text: string, delay = 0): Line => ({ speaker: CAST.sage, text, channel: "sage", delay });

/** Lines the story plays at named beats. */
export const BEATS: Record<string, Line[]> = {
    boot: [s("Augment link established. Vitals nominal. Welcome to the Abyss, Lieutenant.", 2.5)],
    ledgeStart: [r(CAST.okafor, "Lieutenant. Drop's by the beacon - plates and gel. Suit up, then on me.", 1.5)],
    geared: [r(CAST.okafor, "That rockslide is our road down. Single file. Eyes on the walls."), s("Plates bonded. Depth: two hundred and thirty-eight meters.", 4)],
    rampHalf: [
        s("The rock here was cut. Tool marks. There are steps under this rubble."),
        r("Lantern Three", "Kilo, Lantern Three. Movement on the floor, east of you. Could be debris settling.", 5),
        r(CAST.okafor, "Could be.", 9.5),
    ],
    floorReached: [r(CAST.voss, "Kilo-Two, proceed to the structures. Survey only. Nobody touches anything."), s("Air temperature twenty-two degrees. There is moisture here. Living moisture.", 6)],
    settlement: [
        r(CAST.okafor, "No bodies. Where are the people?"),
        r("Pvt. Holt", "Sarge... the lights in the windows. They're still on.", 3.5),
        s("Radiation spike ahead. The shrine. Same signature as the Bore.", 8),
    ],
    shrinePrompt: [s("It is strongest here. Lieutenant - something under the water is still warm.")],
    citizens: [
        r("Pvt. Holt", "Movement! In the street - people! Sarge, there's people!"),
        r(CAST.okafor, "HOLD FIRE. Hold your fire! They're running - they're civilians.", 2.2),
        s("They are running from us, Lieutenant. Into their houses. They are afraid of us.", 4.5),
    ],
    ambushStart: [r(CAST.okafor, "Find cover! Pair up! They're on the roofs!"), r("Pvt. Saarinen", "What is that light?!", 3)],
    manDown: [r(CAST.okafor, "Man down!")],
    fallbackStart: [r(CAST.voss, "Kilo-Two, fall back to the landing zone west of the structures. Lantern Six is inbound for extraction."), r(CAST.okafor, "You heard him. Move! Move!", 5)],
    lantern7Hit: [r("Lantern Seven", "Seven is hit, Seven is hit - I've lost the tail -"), r(CAST.voss, "Seven, Actual. Seven, respond.", 4)],
    evacStart: [r("Lantern Six", "Six on approach, forty-five seconds. Keep that zone clear."), r(CAST.okafor, "Hold this ground! Nobody dies in the last minute!", 4)],
    evacInbound: [r("Lantern Six", "Six, short final. I see your smoke -")],
    evacDown: [r(CAST.okafor, "Six is down! Six is DOWN!"), r(CAST.voss, "Kilo-Two... we can't get another bird into that air. Hold on. Hold on, Kilo.", 4)],
    okaforFalls: [r(CAST.okafor, "Lieutenant... go. Don't let them -")],
    vialPrompt: [s("Vitals critical. Lieutenant - there is a vessel by your hand. The liquid inside is... I cannot tell you what it will do.")],
    surge: [s("...Alex?", 2.5)],
    squadKilled: [r(CAST.okafor, "We lost one! Close up!")],
};

/** Shouts a warden makes (shown with the translator's guess). */
export const WARDEN_SHOUTS: [string, string][] = [
    ["Vael-sha!", "FOR THE RIVER (58%)"],
    ["Ashen tharu!", "... DEFILERS ... (31%)"],
    ["Ilm'ae, ilm'ae!", "THE LIGHT ... THE LIGHT ... (40%)"],
];

/** Barks troopers call out when one of them falls. */
export const MAN_DOWN = ["Man down!", "We lost {name}!", "{name}'s down!", "Medic! - no. No."];

// --- Cutscenes ----------------------------------------------------------------------------------------

/** Kilo-Two's flight in the opening, from the base's pad to Ledge Kilo (seconds from the opening's start). */
export function kiloTwoFlight(t0: number, landY: number): { t: number; pos: V3 }[] {
    const [lx, lz] = PLACES.landing;
    return [
        { t: t0 + 29, pos: [FOB[0] + 20, 6, FOB[1] + 20] },
        { t: t0 + 31.5, pos: [FOB[0] + 18, 22, FOB[1] + 45] },
        { t: t0 + 36, pos: [-640, 62, -1060] },
        { t: t0 + 40.5, pos: [-640, 72, -950] },
        { t: t0 + 44.5, pos: [-632, 20, -880] },
        { t: t0 + 49.5, pos: [-610, -100, -830] },
        { t: t0 + 56, pos: [-600, -185, -790] },
        { t: t0 + 63, pos: [lx + 30, landY + 22, lz - 10] },
        { t: t0 + 70, pos: [lx + 6, landY + 6, lz] },
        { t: t0 + 74, pos: [lx, landY + 0.2, lz] },
    ];
}

const SOURCE_POS: V3 = SOURCE;

export const OPENING: Scene = {
    id: "opening",
    shots: [
        {
            id: "black", duration: 10, letterbox: true, fadeIn: 0, keys: [{ t: 0, pos: [-1060, 34, -1640], target: [-620, 18, -980] }],
            cards: [
                { t: 0.6, dur: 4.6, style: "lore", lines: ["Forty-one hours ago, the Deep Bore struck the source", "of a radiation no instrument could explain,", "hundreds of miles beneath the Meridian Plain."] },
                { t: 5.6, dur: 4.2, style: "lore", lines: ["The blast killed millions -", "above the surface, and, though no one knew it yet, below."] },
            ],
            events: [{ t: 0, name: "black", args: { on: true } }, { t: 9.9, name: "black", args: { on: false } }, { t: 0.5, name: "music", args: { cue: "opening" } }],
        },
        {
            id: "plain", duration: 9, fadeIn: 1.5, ease: "inOut",
            keys: [
                { t: 0, pos: [-1060, 34, -1640], target: [-620, 18, -980], fov: 40 },
                { t: 9, pos: [-930, 78, -1500], target: [-420, -40, -640], fov: 46 },
            ],
            cards: [{ t: 2.5, dur: 5.5, style: "title", lines: ["THE ABYSS"] }],
            subtitles: [{ t: 3, speaker: CAST.voss, text: "All Lantern elements, this is Lantern Actual. Survey window opens in five.", channel: "radio" }],
            events: [{ t: 0, name: "flyover" }],
        },
        {
            id: "swarm", duration: 10, ease: "linear",
            keys: [
                { t: 0, pos: [1250, 430, -1500], target: [-100, -260, -100], fov: 50 },
                { t: 10, pos: [700, 520, -1820], target: [-250, -300, 0], fov: 50 },
            ],
            subtitles: [
                { t: 0.6, speaker: "Lantern Three", text: "Lantern Three on station. Actual, the thermals are... strange. There's warmth all the way down.", channel: "radio" },
                { t: 6.2, speaker: CAST.voss, text: "Copy, Three. Keep your lights on the walls.", channel: "radio" },
            ],
        },
        {
            id: "aboard", duration: 9, ease: "linear",
            keys: [
                { t: 0, follow: "kilo2", offset: [-11, 2.5, 6], lookOffset: [0, 1.4, -1], fov: 40 },
                { t: 9, follow: "kilo2", offset: [-13, 3.5, -4], lookOffset: [0, 1.0, 2], fov: 44 },
            ],
            subtitles: [
                { t: 0.5, speaker: CAST.pilot, text: "Kilo-Two lifting. Two minutes to the ledge.", channel: "radio" },
                { t: 4.2, speaker: CAST.okafor, text: "Helmets on. Whatever did this, it didn't stop at rock.", channel: "voice" },
            ],
        },
        {
            id: "edge", duration: 10, ease: "inOut", shake: 0.15,
            keys: [
                { t: 0, follow: "kilo2", offset: [0, 14, -30], lookOffset: [0, -8, 30], fov: 55 },
                { t: 10, follow: "kilo2", offset: [4, 10, -26], lookOffset: [0, -38, 46], fov: 60 },
            ],
            cards: [{ t: 2.5, dur: 5.5, style: "chapter", lines: ["CHAPTER ONE", "FIRST BLOOD"] }],
            subtitles: [{ t: 3.5, speaker: CAST.sage, text: "Depth one hundred. Two hundred. Sedimentary layers... then something I have no word for.", channel: "sage" }],
        },
        {
            id: "descent", duration: 11, ease: "inOut",
            keys: [
                { t: 0, follow: "kilo2", pos: [-380, -296, -615], offset: [0, 0, 0], lookOffset: [0, -4, 0], fov: 34 },
                { t: 11, follow: "kilo2", pos: [-420, -286, -598], offset: [0, 0, 0], lookOffset: [0, -6, 0], fov: 38 },
            ],
            subtitles: [
                { t: 0.4, speaker: CAST.sage, text: "Thermal returns on the cavern floor. Structures. Patterned. Artificial.", channel: "sage" },
                { t: 5.2, speaker: CAST.voss, text: "Say again, SAGE?", channel: "radio" },
                { t: 7.4, speaker: CAST.sage, text: "There is a city down there, Major.", channel: "sage" },
            ],
        },
        {
            id: "city", duration: 9, ease: "inOut",
            keys: [
                { t: 0, pos: [40, -500, -640], target: [330, -510, -440], fov: 42 },
                { t: 9, pos: [170, -512, -560], target: [SOURCE_POS[0] * 0.5 + 160, -440, SOURCE_POS[2] * 0.5 - 220], fov: 46 },
            ],
            subtitles: [
                { t: 1.2, speaker: CAST.okafor, text: "...Saints.", channel: "radio" },
                { t: 4.5, speaker: CAST.voss, text: "All elements: hold your lights. Nobody touches anything.", channel: "radio" },
            ],
            events: [{ t: 0.5, name: "music", args: { cue: "city" } }],
        },
        {
            id: "touchdown", duration: 9, ease: "inOut", fadeOut: 1.4, shake: 0.08,
            keys: [
                { t: 0, follow: "kilo2", pos: [-610, -228, -705], offset: [0, 0, 0], lookOffset: [0, 2, 0], fov: 44 },
                { t: 9, follow: "kilo2", pos: [-622, -230, -712], offset: [0, 0, 0], lookOffset: [0, 0.8, 0], fov: 40 },
            ],
            subtitles: [
                { t: 1, speaker: CAST.pilot, text: "Kilo-Two, down. Go, go, go.", channel: "radio" },
                { t: 4.5, speaker: CAST.okafor, text: "Out! Lieutenant, on me.", channel: "voice" },
            ],
            events: [{ t: 5, name: "disembark" }],
        },
    ],
};

/** The stand-off at the shrine, and the first bolt. */
export const CONTACT: Scene = {
    id: "contact",
    shots: [
        {
            id: "listen", duration: 6, ease: "inOut", fadeIn: 0.6,
            keys: [
                { t: 0, follow: "alex", offset: [0.7, 1.75, -2.4], lookOffset: [0, 1.4, 12], fov: 48 },
                { t: 6, follow: "alex", offset: [0.9, 1.7, -1.8], lookOffset: [0, 2.2, 12], fov: 44 },
            ],
            subtitles: [
                { t: 0.4, speaker: CAST.sage, text: "Readings spiking. There is something under the -", channel: "sage" },
                { t: 3.6, speaker: "", text: "(a low chant rises from every side)", channel: "caption" },
            ],
            events: [{ t: 2.5, name: "wardensAppear" }, { t: 3.5, name: "music", args: { cue: "contact" } }],
        },
        {
            id: "rooftops", duration: 7, ease: "linear",
            keys: [
                { t: 0, pos: [SHRINE[0] - 20, -536, SHRINE[1] - 30], target: [SHRINE[0] - 40, -528, SHRINE[1] + 60], fov: 40 },
                { t: 7, pos: [SHRINE[0] - 10, -534, SHRINE[1] - 34], target: [SHRINE[0] + 50, -528, SHRINE[1] + 55], fov: 40 },
            ],
            subtitles: [{ t: 1.2, speaker: "TRANSLATOR", text: "UNKNOWN LANGUAGE - ANALYSING (14%)", channel: "translation" }],
        },
        {
            id: "warden", duration: 9, ease: "inOut",
            keys: [
                { t: 0, follow: "warden", offset: [-2.5, 1.6, 7], lookOffset: [0, 1.7, 0], fov: 34 },
                { t: 9, follow: "warden", offset: [-1.5, 1.2, 5], lookOffset: [0, 1.9, 0], fov: 30 },
            ],
            subtitles: [
                { t: 0.8, speaker: CAST.warden, text: "Vael-sha. Ashen tharu, ilm'ae Vaelun kesh...", channel: "voice" },
                { t: 3.6, speaker: "TRANSLATOR", text: "\"...DEFILERS... YOU PUT OUT THE ... MOTHER LIGHT\" (31%)", channel: "translation" },
            ],
            events: [{ t: 1, name: "wardenRaise" }],
        },
        {
            id: "holdfire", duration: 6, ease: "inOut",
            keys: [
                { t: 0, follow: "okafor", offset: [1.4, 1.6, 2.6], lookOffset: [0, 1.5, -0.5], fov: 40 },
                { t: 6, follow: "okafor", offset: [1.8, 1.7, 2.2], lookOffset: [0, 1.6, 0], fov: 38 },
            ],
            subtitles: [
                { t: 0.3, speaker: CAST.voss, text: "All Kilo elements, hold fire. HOLD FIRE. SAGE, open a channel -", channel: "radio" },
                { t: 3.4, speaker: CAST.sage, text: "I have nothing to open it with, Major.", channel: "sage" },
            ],
            events: [{ t: 0, name: "aimUp" }],
        },
        {
            id: "firstbolt", duration: 6, ease: "out",
            keys: [
                { t: 0, follow: "caster", offset: [3, 1.2, 4], lookOffset: [0, 3, -2], fov: 46 },
                { t: 2.2, follow: "lantern4", pos: [SHRINE[0] + 6, -530, SHRINE[1] - 14], offset: [0, 0, 0], lookOffset: [0, 0, 0], fov: 50 },
                { t: 6, follow: "lantern4", pos: [SHRINE[0] + 4, -531, SHRINE[1] - 12], offset: [0, 0, 0], lookOffset: [0, -6, 0], fov: 52 },
            ],
            events: [{ t: 0.6, name: "firstBolt" }],
            subtitles: [{ t: 2.4, speaker: "Lantern Four", text: "I'm hit - I'm -", channel: "radio" }],
            shake: 0.1,
        },
        {
            id: "firstblood", duration: 4, ease: "inOut", fadeOut: 0.5, shake: 0.35,
            keys: [
                { t: 0, follow: "alex", offset: [-1.2, 1.7, -2.6], lookOffset: [0, 1.5, 10], fov: 50 },
                { t: 4, follow: "alex", offset: [-0.6, 1.66, -0.4], lookOffset: [0, 1.6, 10], fov: 46 },
            ],
            subtitles: [{ t: 0.6, speaker: CAST.okafor, text: "CONTACT! Weapons free! WEAPONS FREE!", channel: "voice" }],
            events: [{ t: 0.3, name: "music", args: { cue: "battle" } }],
        },
    ],
};

export const ENDING: Scene = {
    id: "ending",
    shots: [
        {
            id: "aftermath", duration: 9, fadeIn: 2.5, ease: "inOut", grade: { saturation: 0.55, contrast: 1.1 },
            keys: [
                { t: 0, follow: "alex", offset: [0.5, 1.2, 1.8], lookOffset: [0, 0.6, 0], fov: 40 },
                { t: 9, follow: "alex", offset: [3, 6, 9], lookOffset: [0, 0.8, 0], fov: 46 },
            ],
            subtitles: [
                { t: 1.2, speaker: CAST.voss, text: "...any Kilo element... Kilo-Two, this is Lantern Actual... respond...", channel: "radio" },
                { t: 5.5, speaker: CAST.sage, text: "Your vitals are impossible, Lieutenant. Cellular repair at four hundred percent.", channel: "sage" },
            ],
            events: [{ t: 0, name: "music", args: { cue: "ending" } }],
        },
        {
            id: "vial", duration: 7, ease: "inOut", grade: { saturation: 0.6, contrast: 1.1 },
            keys: [
                { t: 0, follow: "vial", offset: [0.6, 0.35, 0.6], lookOffset: [0, 0.05, 0], fov: 32 },
                { t: 7, follow: "vial", offset: [0.9, 0.5, 0.3], lookOffset: [0, 0.05, 0], fov: 30 },
            ],
            subtitles: [{ t: 0.6, speaker: CAST.sage, text: "Whatever you drank... it is still in you.", channel: "sage" }],
        },
        {
            id: "wardenLooks", duration: 11, ease: "inOut", grade: { saturation: 0.6, contrast: 1.1 },
            keys: [
                { t: 0, follow: "warden", offset: [-3, 1.5, 9], lookOffset: [0, 1.4, 0], fov: 34 },
                { t: 11, follow: "warden", offset: [-1.6, 1.6, 5.5], lookOffset: [0, 1.8, 0], fov: 30 },
            ],
            subtitles: [
                { t: 1.5, speaker: CAST.warden, text: "Vaelun kesh... ilm'ae, ilm'ae. Tharu Vael i'sha.", channel: "voice" },
                { t: 4.8, speaker: "TRANSLATOR", text: "\"...YOU DRINK FROM THE RIVER YOU KILLED\" (44%)", channel: "translation" },
            ],
            events: [{ t: 1, name: "wardenKneel" }, { t: 7.5, name: "wardenWithdraw" }],
        },
        {
            id: "light", duration: 9, ease: "inOut", grade: { saturation: 0.75 },
            keys: [
                { t: 0, follow: "alex", offset: [6, 2, -8], lookOffset: [0, 8, 0], fov: 50 },
                { t: 9, follow: "alex", offset: [4, 1.5, -5], lookOffset: [0, 14, 0], fov: 54 },
            ],
            subtitles: [
                { t: 1, speaker: "Lantern Nine", text: "Actual, Nine. I have a beacon on the floor. One - no, two signals.", channel: "radio" },
                { t: 5, speaker: CAST.voss, text: "Kilo-Two, we see you. We see you. Hold on.", channel: "radio" },
            ],
            events: [{ t: 0, name: "rescue" }],
        },
        {
            id: "rise", duration: 13, ease: "inOut", fadeOut: 2,
            keys: [
                { t: 0, pos: [EVAC_LZ[0] + 40, -500, EVAC_LZ[1] - 60], target: [EVAC_LZ[0], -530, EVAC_LZ[1]], fov: 46 },
                { t: 13, pos: [-300, 160, -1500], target: [600, -400, 100], fov: 52 },
            ],
            cards: [
                { t: 1, dur: 5.5, style: "caption", lines: ["Two hundred and eleven of the expedition's", "two hundred and thirty did not come back."] },
                { t: 7, dur: 5.5, style: "caption", lines: ["Below, the kingdoms counted their own dead -", "and named the surface their killers."] },
            ],
        },
        {
            id: "remember", duration: 12, keys: [{ t: 0, pos: [0, 0, 0], target: [0, 0, 1] }],
            cards: [
                { t: 0.8, dur: 5, style: "lore", lines: ["Both worlds would remember who struck first."] },
                { t: 4.2, dur: 4.4, style: "lore", lines: ["Neither would remember it the same way."] },
                { t: 8.4, dur: 3.5, style: "chapter", lines: ["CHAPTER ONE", "FIRST BLOOD"] },
            ],
            events: [{ t: 0, name: "black", args: { on: true } }],
        },
    ],
};

export const SCENES: Record<string, Scene> = { opening: OPENING, contact: CONTACT, ending: ENDING };

/** Where the wardens stand when they reveal themselves (around the shrine: rooftops, rubble, the ridge). */
export const WARDEN_REVEAL: { x: number; z: number; look: string; role: "blade" | "caster" }[] = [
    { x: SHRINE[0] - 38, z: SHRINE[1] + 52, look: "adept", role: "caster" },
    { x: SHRINE[0] + 30, z: SHRINE[1] + 46, look: "warden-f", role: "caster" },
    { x: SHRINE[0] + 52, z: SHRINE[1] + 8, look: "warden-m", role: "blade" },
    { x: SHRINE[0] - 55, z: SHRINE[1] + 6, look: "warden-m", role: "blade" },
    { x: SHRINE[0] + 8, z: SHRINE[1] + 62, look: "warden-f", role: "caster" },
    { x: SHRINE[0] - 18, z: SHRINE[1] + 40, look: "warden-m", role: "blade" },
];

/** The Warden's place during the stand-off: across the shrine from Alex. */
export const WARDEN_STAND: V2 = [SHRINE[0] + 4, SHRINE[1] + 24];

/** Where later waves come from: out of the dark north of the settlement and from the river. */
export const WAVE_SOURCES: V2[] = [[SETTLEMENT[0] + 120, SETTLEMENT[1] + 160], [SETTLEMENT[0] - 60, SETTLEMENT[1] + 190], [SETTLEMENT[0] + 210, SETTLEMENT[1] + 40], [SETTLEMENT[0] - 160, SETTLEMENT[1] + 120]];
