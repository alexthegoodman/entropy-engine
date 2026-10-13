// Chapter Two: Retaliation - the words, the places, the quests and the shots (docs/THE_ABYSS_STORY.md,
// docs/THE_ABYSS_CHAPTER_TWO.md).
//
// Nine days after First Blood the surface has poured its army into the crack and built Firebase
// Lantern on the ground where Kilo-Two died. Alex, the officer who walked out of the Abyss alive -
// with the river's water still in his blood - is kept off the line and given room to roam. The
// floor of the Abyss is open: the main quest ("The Beast Below") leads him to a wounded skywing,
// shot down by his own side on the night of the battle, and to the bond that will carry him out
// of the crack on its back; side quests (a pilot nine days missing, the tags of his dead squad,
// a healer of below and her family's idol, the last transmission of Kilo-Two, a quartermaster's
// salvage) can be taken in any order, or not at all.
//
// Everything here is data; ab_chapter2.ts plays it.

import type { Scene } from "./ab_cinema";
import type { V2, V3 } from "./ab_world";
import { EVAC_LZ, FOB, SHRINE, SETTLEMENT } from "./ab_world";
import type { QuestDef } from "./ab_quests";
import type { Line } from "./ab_script";
import type { EnemyKind } from "./ab_rpg";

export const CAST2 = {
    voss: "Maj. Voss",
    dace: "QM Dace",
    brask: "BRASK-7",
    pell: "WO Pell",
    maelis: "Maelis",
    sage: "SAGE",
    alex: "Lt. Alex",
} as const;

// --- Places ------------------------------------------------------------------------------------------

const [fx, fz] = EVAC_LZ;

export const PLACES2 = {
    /** Firebase Lantern: the surface's fortress on the floor, raised on Kilo-Two's landing zone. */
    firebase: EVAC_LZ as V2,
    voss: [fx + 14, fz + 16] as V2,
    dace: [fx - 22, fz + 8] as V2,
    brask: [fx + 6, fz - 22] as V2,
    memorial: [fx + 2, fz - 26] as V2,
    crate: [fx - 27, fz + 13] as V2,
    pellHome: [fx - 10, fz - 6] as V2,
    /** Where the player starts the chapter (and wakes after the augment restarts). */
    spawn: [fx + 4, fz + 2] as V2,
    /** Lantern Four's wreck by the shrine; Lantern Seven's south of the settlement. */
    wreck4: [296, -520] as V2,
    wreck7: [205, -640] as V2,
    pellWreck: [199, -634] as V2,
    /** The hollow north of the firebase (about 500 m out) where the skywing came down, and the glowing trail to it from Lantern Four's wreck. */
    hollow: [70, -62] as V2,
    kesh: [76, -56] as V2,
    trail: [[288, -500], [270, -446], [248, -392], [222, -338], [194, -282], [164, -226], [134, -170], [108, -120], [88, -86]] as V2[],
    /** The healer's hiding place among the settlement's northern ruins. */
    maelis: [250, -300] as V2,
    /** The dying Source's pool, where river water can still be drawn. */
    sourceFill: [1240, 70] as V2,
    /** The relay drone, on a ledge high on the north wall (only reachable by air). */
    relay: [-280, 770] as V2,
    /** Forward Base Lantern on the south rim. */
    fob: FOB,
    shrine: SHRINE,
    settlement: SETTLEMENT,
};

// --- Places of note and the encounters at them ---------------------------------------------------------

/**
 * Places to find on the open floor and the surface above it. Coming within `radius` discovers
 * one (experience, SAGE's note, the journal's list). Some are guarded: an encounter (below)
 * waits there.
 */
export interface PlaceOfNote { id: string; name: string; at: V2; radius: number; text: string; surface?: boolean }

export const PLACES_OF_NOTE: PlaceOfNote[] = [
    { id: "vigil", name: "The Champion's Vigil", at: [-420, -262], radius: 70, text: "A gate of carved stone with nothing behind it. Someone stands watch anyway." },
    { id: "stair", name: "The Drowned Stair", at: [960, -118], radius: 70, text: "Steps cut down into the riverbed, worn by feet. The water used to cover all of them." },
    { id: "circle", name: "The Seer's Circle", at: [640, 160], radius: 70, text: "Crystals set in a ring, humming. SAGE logs the hum as speech." },
    { id: "bonefield", name: "The Bone Field", at: [-760, 320], radius: 90, text: "Ribs as tall as a gunship. The kingdoms bring their war beasts here to die." },
    { id: "gardens", name: "The Whispering Vein", at: [-200, 445], radius: 60, text: "A slab of the north wall, fallen in the blast - and already hollow. The kingdoms had carved a temple into it before it fell." },
    { id: "source", name: "The Source", at: [1240, 70], radius: 120, text: "The sacred waterfall. Dying - you can hear it stammer." },
    { id: "shrine", name: "Shrine of the River", at: SHRINE, radius: 40, text: "Where First Blood began. Someone has laid fresh vials at the basin." },
    { id: "westdark", name: "The Western Dark", at: [-1450, 0], radius: 160, text: "The rift runs on into the west - three hundred kilometers of it, SAGE says, unmapped. The air past here would kill you." },
    { id: "station9", name: "Bore Station Nine", at: [900, -1250], radius: 90, text: "A Deep Bore survey station, its fences down. Its sentinels never got the order to stand down.", surface: true },
    { id: "lifter", name: "The Fallen Lifter", at: [-1250, 1150], radius: 90, text: "A heavy lifter, broken across a crater. The Bore's crates are still strapped in.", surface: true },
    { id: "kappa", name: "Relay Mast Kappa", at: [420, 1300], radius: 90, text: "A relay mast, still blinking. Something is still guarding it.", surface: true },
    { id: "convoy", name: "The Scorched Convoy", at: [-1250, -1260], radius: 90, text: "Eleven trucks of the first relief convoy, burned where the blast caught them.", surface: true },
];

export type GuardSpec = { kind: EnemyKind; dx: number; dz: number; rank?: "initiate" | "veteran" | "elite" };

/**
 * Encounters: what waits at a place, and what is there to take. They begin when Alex comes near
 * (a quest of their own, never offered by anyone) and end when the prize is taken - by fighting
 * through the guard, or by creeping past it.
 */
export interface EncounterDef {
    id: string;
    place: string;
    /** How near Alex comes before it begins (m). */
    begins: number;
    guards: GuardSpec[];
    /** The prize: a potion of the river (a power id) or a tech cache (an upgrade id). */
    prize: { kind: "potion" | "tech"; id: string; label: string; at?: [number, number] }[];
    /** A behemoth leads it (its rider is an adept in the howdah). */
    behemoth?: boolean;
    lines: Line[];
}

export const ENCOUNTERS: EncounterDef[] = [
    { id: "vigil", place: "vigil", begins: 170, guards: [{ kind: "champion", dx: 0, dz: 8, rank: "veteran" }, { kind: "skirmisher", dx: -12, dz: -4 }, { kind: "skirmisher", dx: 12, dz: -2 }],
        prize: [{ kind: "potion", id: "lance", label: "Draught of the Lance" }],
        lines: [{ speaker: "SAGE", text: "A champion of the wardens, Lieutenant. It is guarding a vessel - the light in it is the same as the shards'.", channel: "sage" }] },
    { id: "stair", place: "stair", begins: 170, guards: [{ kind: "champion", dx: 6, dz: 10 }, { kind: "adept", dx: -14, dz: 12, rank: "veteran" }, { kind: "staff", dx: 16, dz: -6 }, { kind: "warden", dx: -6, dz: -14 }],
        prize: [{ kind: "potion", id: "ward", label: "Draught of Still Water" }],
        lines: [{ speaker: "SAGE", text: "Wardens on the stair, and something on the lowest step that drinks the light.", channel: "sage" }] },
    { id: "circle", place: "circle", begins: 170, guards: [{ kind: "seer", dx: 0, dz: 0, rank: "veteran" }, { kind: "adept", dx: 14, dz: 6 }, { kind: "adept", dx: -12, dz: 8 }, { kind: "skirmisher", dx: 4, dz: -16 }],
        prize: [{ kind: "potion", id: "mend", label: "Draught of Mending" }],
        lines: [{ speaker: "SAGE", text: "A seer and its circle. Take the seer first - it mends the others.", channel: "sage" }] },
    { id: "gardens", place: "gardens", begins: 140,
        // In the dark of the cave: two at the mouth, the rest in the chamber with the prize.
        guards: [{ kind: "skirmisher", dx: 3, dz: 12, rank: "veteran" }, { kind: "staff", dx: -4, dz: 24 }, { kind: "skirmisher", dx: -14, dz: 58, rank: "elite" }, { kind: "seer", dx: -18, dz: 64 }, { kind: "warden", dx: -10, dz: 66 }],
        prize: [{ kind: "potion", id: "veil", label: "Draught of the Veil", at: [-16, 61] }],
        lines: [
            { speaker: "SAGE", text: "A cave, Lieutenant. My sensors stop at its mouth.", channel: "sage" },
            { speaker: "SAGE", text: "Something in there moves like the light does. I lose it between frames.", channel: "sage", delay: 2.5 },
        ] },
    { id: "bonefield", place: "bonefield", begins: 260, behemoth: true, guards: [{ kind: "behemoth", dx: 0, dz: 0, rank: "elite" }, { kind: "warden", dx: -18, dz: 10 }, { kind: "warden", dx: 18, dz: 12 }, { kind: "adept", dx: 0, dz: -22, rank: "veteran" }],
        prize: [{ kind: "potion", id: "surge", label: "Draught of the Surge", at: [20, 30] }],
        lines: [
            { speaker: "SAGE", text: "Lieutenant. Something very large is moving in the bone field.", channel: "sage" },
            { speaker: "SAGE", text: "It breathes fire. Keep stone between you and its head.", channel: "sage", delay: 2.5 },
        ] },
    { id: "station9", place: "station9", begins: 220, guards: [{ kind: "synthetic", dx: -12, dz: 0 }, { kind: "synthetic", dx: 10, dz: 8 }, { kind: "synthetic", dx: 2, dz: -14, rank: "veteran" }, { kind: "synthetic", dx: 18, dz: -10 }],
        prize: [{ kind: "tech", id: "weave", label: "Dermal Weave", at: [-4, 4] }, { kind: "tech", id: "reflex", label: "Reflex Booster", at: [6, -6] }],
        lines: [{ speaker: "SAGE", text: "Bore security sentinels. They are not answering my codes. They are not answering anyone's.", channel: "sage" }] },
    { id: "lifter", place: "lifter", begins: 220, guards: [{ kind: "synthetic", dx: -10, dz: 6, rank: "veteran" }, { kind: "synthetic", dx: 12, dz: -4 }, { kind: "synthetic", dx: 0, dz: 16 }],
        prize: [{ kind: "tech", id: "dampers", label: "Kinetic Dampers" }],
        lines: [{ speaker: "SAGE", text: "The lifter's cargo manifest lists augment hardware. Its guards have not noticed it crashed.", channel: "sage" }] },
    { id: "kappa", place: "kappa", begins: 220, guards: [{ kind: "synthetic", dx: -8, dz: -8 }, { kind: "synthetic", dx: 10, dz: 10, rank: "veteran" }, { kind: "synthetic", dx: -14, dz: 12 }],
        prize: [{ kind: "tech", id: "optics", label: "Optic Overlay II" }],
        lines: [{ speaker: "SAGE", text: "The mast's maintenance cache holds an optics package. Three sentinels between us and it.", channel: "sage" }] },
    { id: "convoy", place: "convoy", begins: 220, guards: [{ kind: "synthetic", dx: -10, dz: 0, rank: "elite" }, { kind: "synthetic", dx: 12, dz: 6 }, { kind: "synthetic", dx: 2, dz: 16 }, { kind: "synthetic", dx: -4, dz: -16 }],
        prize: [{ kind: "tech", id: "medpump", label: "Subdermal Medpump" }],
        lines: [{ speaker: "SAGE", text: "The convoy's field hospital. Its medpumps survived. Its sentinels did too.", channel: "sage" }] },
];

/** Missions that find Alex: they start when he comes near, by a call on the radio or what he sees. */
export const ELEVEN: V2 = [-560, -118];
export const PROCESSION: V2 = [560, 300];

/** The tags of Kilo-Two's dead, where they fell in Chapter One. */
export const DOG_TAGS: { name: string; at: V2 }[] = [
    { name: "Pvt. Holt", at: [SHRINE[0] + 22, SHRINE[1] + 18] },
    { name: "Pvt. Saarinen", at: [SHRINE[0] - 34, SHRINE[1] - 12] },
    { name: "Spc. Vey", at: [180, -470] },
    { name: "Pvt. Barre", at: [96, -560] },
    { name: "Cpl. Reyes", at: [fx + 38, fz + 30] },
    { name: "Pvt. Ashby", at: [fx - 46, fz + 36] },
];

/**
 * Warden patrols that roam the wild parts of the floor: where they gather, how many, and who. The
 * further from the firebase, the more of them are veterans and elites (ab_chapter2.ts danger).
 */
export const PATROLS: { id: string; at: V2; n: number; kinds: EnemyKind[] }[] = [
    { id: "riverbank", at: [520, -160], n: 3, kinds: ["warden", "adept", "staff"] },
    { id: "eastfloor", at: [760, -60], n: 4, kinds: ["warden", "skirmisher", "adept", "seer"] },
    { id: "westhollow", at: [-320, 280], n: 3, kinds: ["staff", "warden", "skirmisher"] },
    { id: "sourceway", at: [880, 320], n: 5, kinds: ["adept", "warden", "seer", "skirmisher", "warden"] },
    { id: "settlement", at: [420, -260], n: 3, kinds: ["warden", "staff", "adept"] },
    { id: "northfloor", at: [200, 520], n: 4, kinds: ["skirmisher", "skirmisher", "adept", "warden"] },
    { id: "deepwest", at: [-900, 120], n: 5, kinds: ["warden", "seer", "adept", "skirmisher", "warden"] },
];

// --- The people of the chapter -----------------------------------------------------------------------

export interface Npc { id: string; name: string; look: string; at: V2 | null; faceTo?: V2; faction: "surface" | "neutral"; role: string }

export const NPCS: Npc[] = [
    { id: "voss", name: CAST2.voss, look: "officer", at: PLACES2.voss, faceTo: PLACES2.spawn, faction: "surface", role: "Firebase command" },
    { id: "dace", name: CAST2.dace, look: "trooper-f", at: PLACES2.dace, faceTo: PLACES2.spawn, faction: "surface", role: "Quartermaster - trade" },
    { id: "brask", name: CAST2.brask, look: "synthetic", at: PLACES2.brask, faceTo: PLACES2.memorial, faction: "surface", role: "Kilo-Two" },
    { id: "maelis", name: CAST2.maelis, look: "healer", at: PLACES2.maelis, faceTo: SHRINE, faction: "neutral", role: "A healer of below" },
    // Pell appears when her wreck is found.
    { id: "pell", name: CAST2.pell, look: "trooper-f", at: null, faction: "surface", role: "Lantern Seven" },
    // Met out on the floor (the missions that find you).
    { id: "hale", name: "Chief Hale", look: "trooper-m", at: null, faction: "surface", role: "Lantern Eleven" },
    { id: "elder", name: "The Elder", look: "citizen-old", at: null, faction: "neutral", role: "A pilgrim of below" },
];

/** The firebase's sentries: where they stand and which way they look. */
export const SENTRIES: { look: string; at: V2; face: V2 }[] = [
    { look: "trooper-m", at: [fx + 46, fz + 40], face: [fx + 120, fz + 120] },
    { look: "trooper-f", at: [fx - 50, fz + 44], face: [fx - 120, fz + 120] },
    { look: "trooper-m", at: [fx + 58, fz - 20], face: [fx + 160, fz - 20] },
    { look: "trooper-m", at: [fx - 60, fz - 26], face: [fx - 160, fz - 30] },
    { look: "trooper-f", at: [fx + 4, fz + 54], face: [fx + 4, fz + 160] },
];

// --- The quests -----------------------------------------------------------------------------------------

export const QUESTS: QuestDef[] = [
    {
        id: "beast", title: "The Beast Below", kind: "main", giver: null, offeredAt: null,
        summary: "Lantern Four went down over the shrine with its recorder intact. Something else went down with it.",
        stages: [
            { id: "report", text: "Report to Major Voss", marker: "npc:voss", trigger: { kind: "talk", npc: "voss" } },
            { id: "recorder", text: "Recover Lantern Four's flight recorder", marker: PLACES2.wreck4, trigger: { kind: "collect", counter: "recorder", count: 1 }, enter: ["placeRecorder"], done: ["recorderHeard"], hint: "The wreck lies by the shrine, east of the firebase." },
            { id: "trail", text: "Follow the glowing trail", marker: PLACES2.hollow, trigger: { kind: "reach", at: PLACES2.hollow, radius: 42 }, enter: ["showTrail"], done: ["foundScene"], hint: "Whatever bled that light went north, away from the river." },
            { id: "defend", text: "Drive off the hunters", marker: null, trigger: { kind: "kill", tag: "hunters", count: 4 }, enter: ["spawnHunters"], done: ["huntersGone"] },
            { id: "calm", text: "Calm the creature - approach slowly [E]", marker: "creature", trigger: { kind: "flag", flag: "calmed" }, hint: "Walk, don't run. Keep your weapon quiet. Let it see you." },
            { id: "water", text: "Bring it the river's water", marker: PLACES2.sourceFill, trigger: { kind: "flag", flag: "riverWater" }, enter: ["waterHint"], hint: "The Source's pool, far to the east, still holds a little. Or ask the people of below - they keep the water in vessels." },
            { id: "heal", text: "Pour the river's water over the wound [E]", marker: "creature", trigger: { kind: "interact", site: "creature-heal" }, done: ["skyboundScene"] },
            { id: "mount", text: "Climb on [E]", marker: "creature", trigger: { kind: "flag", flag: "mounted" } },
            { id: "rim", text: "Fly up out of the Abyss", marker: PLACES2.fob, trigger: { kind: "reach", at: [0, 0], radius: 1e6, air: true, above: 25 }, enter: ["flightTips"] },
            { id: "fob", text: "Land at Forward Base Lantern", marker: PLACES2.fob, trigger: { kind: "reach", at: PLACES2.fob, radius: 140, air: false }, done: ["firstLightScene"] },
        ],
        reward: { credits: 500, text: "Kesh will carry you anywhere now. Whistle [V] and it comes." },
    },
    {
        id: "seven", title: "Seven Is Down", kind: "side", giver: "dace", offeredAt: "npc:dace",
        summary: "Lantern Seven's pilot, Warrant Officer Pell, was never recovered. Dace hasn't stopped listening for her.",
        stages: [
            { id: "wreck", text: "Find Lantern Seven's wreck", marker: PLACES2.wreck7, trigger: { kind: "reach", at: PLACES2.wreck7, radius: 26 }, done: ["pellFound"], hint: "South of the settlement, toward the wall." },
            { id: "talk", text: "Speak to the pilot", marker: "npc:pell", trigger: { kind: "talk", npc: "pell" } },
            { id: "defend", text: "Hold off the wardens", marker: null, trigger: { kind: "kill", tag: "seven", count: 4 }, enter: ["spawnSeven"] },
            { id: "check", text: "Check on Pell", marker: "npc:pell", trigger: { kind: "talk", npc: "pell" }, done: ["pellHome"] },
            { id: "home", text: "Meet Pell at the firebase", marker: "npc:pell", trigger: { kind: "talk", npc: "pell" } },
        ],
        reward: { credits: 300, items: ["plates-mk3"], text: "Pell's crew chief rigs you a set of Aegis Mk.III plates." },
    },
    {
        id: "tags", title: "Names in the Dust", kind: "side", giver: "brask", offeredAt: "npc:brask",
        summary: "Six of Kilo-Two fell on the floor. Recovery took the bodies; nobody took the tags.",
        stages: [
            { id: "collect", text: "Recover Kilo-Two's tags", marker: null, trigger: { kind: "collect", counter: "dogtag", count: 6 }, enter: ["placeTags"], hint: "Where they fell: round the shrine, the road west, the landing zone. [Q] scans for them." },
            { id: "memorial", text: "Hang the tags at the memorial [E]", marker: PLACES2.memorial, trigger: { kind: "interact", site: "memorial" } },
        ],
        reward: { items: ["okafor-carbine"], text: "BRASK-7 gives you Sgt. Okafor's carbine. \"She would want it used.\"" },
    },
    {
        id: "idol", title: "The River Idol", kind: "side", giver: "maelis", offeredAt: "npc:maelis",
        summary: "A healer of below hides in the ruins north of the shrine. The surface took her family's river idol.",
        stages: [
            { id: "crate", text: "Find her family's idol in the recovered artifacts [E]", marker: PLACES2.crate, trigger: { kind: "interact", site: "crate" }, hint: "Recovery stacks everything it takes beside the quartermaster." },
            { id: "decide", text: "Return the idol to Maelis - or sell it to Dace", marker: "npc:maelis", trigger: { kind: "choice", id: "idol" }, done: ["idolOutcome"] },
        ],
        reward: { text: "" },
    },
    {
        id: "shards", title: "Salvage Rights", kind: "side", giver: "dace", offeredAt: "npc:dace",
        summary: "Surface labs will pay anything for lumen shards. Dace takes a cut, and so do you.",
        stages: [
            { id: "collect", text: "Collect lumen shards", marker: null, trigger: { kind: "collect", counter: "lumen", count: 5 }, enter: ["placeShards"], hint: "They glow faintly in the open floor. [Q] scans for them." },
            { id: "deliver", text: "Bring the shards to Dace", marker: "npc:dace", trigger: { kind: "talk", npc: "dace" }, done: ["shardsDelivered"] },
        ],
        reward: { credits: 450, items: ["medgel", "medgel"], text: "Dace pays out - and throws in two medgel." },
    },
    {
        id: "relay", title: "Last Transmission", kind: "side", giver: "brask", offeredAt: "npc:brask", requires: ["stage:beast/rim"],
        summary: "Kilo-Two's relay drone carried the squad's telemetry to the end. It came down on a ledge no one can climb to.",
        stages: [
            { id: "core", text: "Recover the relay's core from the north wall", marker: PLACES2.relay, trigger: { kind: "collect", counter: "relay", count: 1 }, enter: ["placeRelay"], hint: "High on the north wall. Only something with wings gets there." },
            { id: "return", text: "Bring the core to BRASK-7", marker: "npc:brask", trigger: { kind: "talk", npc: "brask" }, done: ["relayHeard"] },
        ],
        reward: { credits: 400, text: "BRASK-7 patches the relay into your augment: scans reach twice as far." },
    },
    // --- Missions that find you (no giver: they begin when Alex comes near) ---
    {
        id: "eleven", title: "Eleven Is Down", kind: "encounter", giver: null, offeredAt: null,
        summary: "Lantern Eleven's crew put down by the river and the wardens found them first. Their call is on every channel.",
        stages: [
            { id: "reach", text: "Reach Lantern Eleven's crew", marker: ELEVEN, trigger: { kind: "reach", at: ELEVEN, radius: 40 }, enter: ["elevenCall"] },
            { id: "defend", text: "Drive the wardens off the crew", marker: null, trigger: { kind: "kill", tag: "eleven", count: 5 }, enter: ["spawnEleven"] },
            { id: "talk", text: "Speak to the crew chief", marker: "npc:hale", trigger: { kind: "talk", npc: "hale" } },
        ],
        reward: { credits: 250, items: ["medgel", "medgel", "draught"], text: "Chief Hale presses medgel and a captured river draught on you." },
    },
    {
        id: "procession", title: "The Last Procession", kind: "encounter", giver: null, offeredAt: null,
        summary: "Pilgrims of below carry vials of the river toward the Source. The Bore's sentinels have come down into the crack, and they shoot whatever moves.",
        stages: [
            { id: "defend", text: "Protect the pilgrims from the sentinels", marker: PROCESSION, trigger: { kind: "kill", tag: "procession", count: 4 }, enter: ["spawnProcession"] },
            { id: "talk", text: "Speak to the elder", marker: "npc:elder", trigger: { kind: "talk", npc: "elder" } },
        ],
        reward: { items: ["draught", "draught", "draught"], text: "The elder gives you three vials of the river. The translator learns the word for 'thank you'." },
    },
    ...ENCOUNTERS.map((e): QuestDef => {
        const place = PLACES_OF_NOTE.find(p => p.id === e.place)!;
        return {
            id: `enc-${e.id}`, title: place.name, kind: "encounter", giver: null, offeredAt: null,
            summary: e.prize.map(p => p.label).join(" and ") + " - guarded.",
            stages: [{ id: "take", text: `Take the ${e.prize.map(p => p.label).join(" and the ")}${e.prize.length > 1 ? "" : ""} (guarded)`, marker: place.at, trigger: { kind: "collect", counter: `got:${e.id}`, count: e.prize.length }, enter: [`encounter:${e.id}`] }],
            reward: { text: `${place.name}: cleared.` },
        };
    }),
];

// --- Lines ---------------------------------------------------------------------------------------------

const v = (speaker: string, text: string, delay = 0): Line => ({ speaker, text, channel: "voice", delay });
const r = (speaker: string, text: string, delay = 0): Line => ({ speaker, text, channel: "radio", delay });
const s = (text: string, delay = 0): Line => ({ speaker: CAST2.sage, text, channel: "sage", delay });
const tr = (text: string, delay = 0): Line => ({ speaker: "TRANSLATOR", text, channel: "translation", delay });

/** What givers say when they offer a quest (talking to them starts it). */
export const OFFERS: Record<string, Line[]> = {
    seven: [v(CAST2.dace, "Lantern Seven. Pell. Command lists her as lost, but nobody's walked that wreck."), v(CAST2.dace, "You've got free legs and a free pass, Lieutenant. Go look. Please.", 0.4)],
    tags: [v(CAST2.brask, "Lieutenant. Recovery took Kilo-Two's dead. They did not take the tags."), v(CAST2.brask, "I have their last positions. I cannot leave my post. You can.", 0.4)],
    idol: [v(CAST2.maelis, "Ilm'ae... surface. Vael-dar osh kesh, ilm'ae tharu."), tr("\"...LIGHT ... MY HOUSE'S ... VESSEL ... YOUR PEOPLE TOOK\" (29%)", 0.2), s("She means the river idols, Lieutenant. Recovery has been crating them by the hundred.", 0.4)],
    shards: [v(CAST2.dace, "Labs topside pay a fortune for lumen shards. You find them, I ship them, we split it."), v(CAST2.dace, "Five will do for a start.", 0.3)],
    relay: [v(CAST2.brask, "Kilo-Two's relay drone fell on the north wall. Its core holds their telemetry to the end."), v(CAST2.brask, "Their families should hear it from a record, not a report. Your creature can reach it.", 0.4)],
};

/** What is said when a stage is entered (or a talk finishes one): keyed quest/stage. */
export const STAGE_LINES: Record<string, Line[]> = {
    "beast/report": [],
    "beast/recorder": [
        v(CAST2.voss, "Lieutenant. You're upright. SAGE says you shouldn't be."),
        v(CAST2.voss, "I can't put you back on the line - the medics want you in a jar. So here's work nobody else will take.", 0.3),
        v(CAST2.voss, "Lantern Four went down by the shrine with its recorder intact. Recovery won't go near that settlement. Bring it back.", 0.3),
        v(CAST2.voss, "And Alex - the floor is yours. Go where SAGE can't see. Just come back.", 0.5),
    ],
    "beast/trail": [s("The recorder kept running after the crash. Listen."), { speaker: "", text: "(a long, broken cry, far away)", channel: "caption", delay: 0.3 }, s("Lantern Four's gun camera logged a burst at something in the air. Something large. It is not ours, and it is bleeding light.", 0.5)],
    "beast/defend": [s("Wardens, closing on the creature. They think you came to finish it."), r("Lantern Actual", "Alex, Actual. You have hostiles converging on your position. You are on your own down there.", 1)],
    "beast/calm": [s("They are gone. Lieutenant - it is watching you. Slowly.")],
    "beast/water": [s("The wound will not close. It is the same wound the river's water closed in you."), s("The Source's pool still holds a little, far east. Or the people of below keep the water in vessels.", 1)],
    "beast/mount": [s("It is lowering its neck to you. I believe that is an invitation.")],
    "beast/rim": [s("Pull back to climb. Space beats the wings. Shift dives - it costs breath. [E] near the ground sets down.")],
    "beast/fob": [r("Lantern Actual", "All Lantern elements, unknown contact rising out of the crack - hold fire, HOLD FIRE -"), r("Lantern Actual", "...is that a man on its back?", 3)],
    "seven/talk": [v(CAST2.pell, "Don't - don't shoot. Surface. I'm surface. Lantern Seven.")],
    "seven/defend": [v(CAST2.pell, "Oh no. No no no - they've found me again. They come every night!"), s("Wardens. Four of them.", 1)],
    "seven/check": [],
    "seven/home": [v(CAST2.pell, "I can walk. I can see your firebase lights from here. Nine days I watched them.")],
    "tags/memorial": [],
    "idol/decide": [],
    "shards/deliver": [],
    "relay/return": [],
    "eleven/reach": [r("Lantern Eleven", "Any element, any element, Lantern Eleven - we're down by the river bend, west of you - they're on us!"), s("Their beacon is four hundred meters west, Lieutenant.", 2)],
    "eleven/defend": [r("Lantern Eleven", "Is that - surface! Surface on our left! Keep them off the wreck!")],
    "eleven/talk": [],
    "procession/defend": [s("Pilgrims, Lieutenant. Carrying vials toward the Source. And Bore sentinels - they are shooting them."), v("The Elder", "Ilm'ae! Ilm'ae tharu!", 2), tr("\"LIGHT ... HELP US\" (52%)", 2.2)],
    "procession/talk": [],
};

/** Lines when a talk finishes a stage (keyed quest/stage of the stage that was finished). */
export const TALK_LINES: Record<string, Line[]> = {
    "seven/talk": [v(CAST2.pell, "Nine days. I drank from a crack in the rock. It glows, did you know that? It tastes like... light."), v(CAST2.pell, "You're Kilo-Two. I saw you on the zone. I'm sorry. I'm so sorry.", 0.3)],
    "seven/check": [v(CAST2.pell, "...Thank you. I'll make for the firebase. Don't follow me - I want to walk it. I need to walk it.")],
    "seven/home": [v(CAST2.pell, "Chief says I've got you to thank for the ride home. I didn't ride. I walked."), v(CAST2.pell, "Take the plates. They were meant for my gunner.", 0.4)],
    "shards/deliver": [v(CAST2.dace, "Look at that glow. The labs will lose their minds. Here's your cut.")],
    "eleven/talk": [v("Chief Hale", "Chief Hale, Lantern Eleven. Two of mine aren't getting up, Lieutenant. The rest of us are, because of you."), v("Chief Hale", "Take these. And tell Voss the river bend isn't ours, whatever the boards say.", 0.4)],
    "procession/talk": [v("The Elder", "Kesh oth vael... ashen-kin, vael i'sha."), tr("\"YOU WHO CAME DOWN WITH THE FIRE ... THE RIVER REMEMBERS YOU\" (49%)", 0.2), s("They are giving you their vials, Lieutenant. All of them.", 0.5)],
    "relay/return": [v(CAST2.brask, "Playing."), r("Sgt. Okafor", "...Kilo-Two, hold this ground. Nobody dies in the last minute.", 1.2), v(CAST2.brask, "Thank you, Lieutenant. I will send it home.", 4.5)],
};

/** What each NPC says when there is nothing new (cycled). */
export const IDLE: Record<string, Line[][]> = {
    voss: [[v(CAST2.voss, "Command wants a war, Lieutenant. I'm trying to give them a firebase instead.")], [v(CAST2.voss, "Every gunship I put over that settlement, the kingdoms answer with three more casters. Retaliation. It's a word for politicians.")]],
    dace: [[v(CAST2.dace, "Credits for artifacts, gear for credits. Let's trade.")]],
    brask: [[v(CAST2.brask, "I keep the watch, Lieutenant. Someone of Kilo-Two should.")], [v(CAST2.brask, "Sgt. Okafor taught me to say 'saints'. I do not know what they are. I say it anyway.")]],
    maelis: [[v(CAST2.maelis, "Vael i'sha."), tr("\"THE RIVER ... REMEMBERS\" (41%)", 0.2)]],
    pell: [[v(CAST2.pell, "Still walking, Lieutenant.")]],
    hale: [[v("Chief Hale", "Eleven owes you one, Lieutenant. When the bird flies again, you ride free.")]],
    elder: [[v("The Elder", "Vael i'sha, ashen-kin."), tr("\"THE RIVER REMEMBERS ... SURFACE-FRIEND\" (47%)", 0.2)]],
};

/** Barks when a quest is finished. */
export const DONE_LINES: Record<string, Line[]> = {
    beast: [r(CAST2.voss, "Alex. You flew it out of the Abyss. Command's going to want that animal."), r(CAST2.voss, "...I'm going to tell them it bites.", 3)],
    tags: [v(CAST2.brask, "Holt. Saarinen. Vey. Barre. Reyes. Ashby."), v(CAST2.brask, "And Okafor. Her carbine is yours, Lieutenant. She would want it used.", 0.6)],
    seven: [],
    shards: [],
    relay: [],
};

/** The idol's two ends. */
export const IDOL_LINES = {
    returned: [v(CAST2.maelis, "...Ilm'ae. Ilm'ae vael."), tr("\"...THE LIGHT ... THE LIGHT RETURNS\" (63%)", 0.2), v(CAST2.maelis, "Kesh oth vael. Tharu kesh.", 0.4), tr("\"FOR THE LITTLE LIGHT ... FOR YOUR WOUND\" (52%)", 0.2), s("She has given you a vessel of river water, Lieutenant. And the translator has learned forty new words.", 0.5)],
    sold: [v(CAST2.dace, "Nine hundred. Don't tell me where it's from and I won't ask."), s("The healer has gone from the ruins, Lieutenant.", 2)],
};

export const SAGE_LINES = {
    trustRise: [s("Easy. It is letting you closer."), s("Its breathing has slowed. Keep going.")],
    trustFlinch: s("It flinched. Too fast, Lieutenant - or too loud."),
    calmed: [s("It has let you touch it. Lieutenant... it is warm. The same warmth as the vial."), s("It is still dying. It needs the river.", 1.5)],
    water: s("River water. It is faintly warm. Bring it to the creature."),
    sourceFill: s("Drawn from the Source's own pool. What is left of it."),
    whistle: s("It heard you."),
    noLand: s("Too high to set down, Lieutenant. Get lower."),
    scanBoost: s("Relay core patched in. Scan range doubled."),
};

// --- The quartermaster's shop ---------------------------------------------------------------------------

export interface ShopItem { id: string; label: string; price: number; note: string }

export const SHOP: ShopItem[] = [
    { id: "medgel", label: "MEDGEL", price: 80, note: "55 vitals, applied in a breath." },
    { id: "ammo", label: "COIL SLUGS x96", price: 60, note: "Rifle and carbine reserve." },
    { id: "refit", label: "PLATE REFIT", price: 120, note: "Plates back to full." },
    { id: "saddle", label: "SADDLE RIG", price: 300, note: "Expedition webbing, cut to a skywing's back." },
];

// --- Cutscenes -------------------------------------------------------------------------------------------

/** Chapter Two opens on the firebase nine days after First Blood. */
export const AFTERMATH: Scene = {
    id: "aftermath",
    shots: [
        {
            id: "black", duration: 10, letterbox: true, keys: [{ t: 0, pos: [fx + 60, -470, fz - 120], target: [fx, -530, fz] }],
            cards: [
                { t: 0.6, dur: 4.4, style: "lore", lines: ["Nine days after First Blood,", "the surface answered."] },
                { t: 5.4, dur: 4.2, style: "lore", lines: ["Four hundred aircraft. Eleven thousand soldiers.", "A fortress raised where Kilo-Two fell."] },
            ],
            events: [{ t: 0, name: "black", args: { on: true } }, { t: 9.9, name: "black", args: { on: false } }, { t: 0.5, name: "music", args: { cue: "ch2" } }],
        },
        {
            // What the surface decided, and what the kingdoms answered.
            id: "parliament", duration: 10, fadeIn: 1.2, ease: "inOut", letterbox: true,
            keys: [
                { t: 0, pos: [-760, 60, -1420], target: [-640, 5, -1180], fov: 40 },
                { t: 10, pos: [-700, 45, -1330], target: [-600, 0, -1120], fov: 38 },
            ],
            cards: [
                { t: 0.6, dur: 4.4, style: "lore", lines: ["The Meridian Parliament voted for retaliation,", "two hundred and twelve to one hundred and ninety. SAGE abstained."] },
                { t: 5.4, dur: 4.2, style: "lore", lines: ["Below, the kingdoms that had never needed a war council", "convened one for the first time in nine hundred years."] },
            ],
            subtitles: [{ t: 7.6, speaker: CAST2.sage, text: "I counted every death of First Blood, Lieutenant. Theirs and ours. The numbers were the same.", channel: "sage" }],
        },
        {
            id: "fleet", duration: 9, fadeIn: 1.5, ease: "inOut",
            keys: [
                { t: 0, pos: [-900, 120, -1250], target: [-100, -300, -300], fov: 48 },
                { t: 9, pos: [-700, 60, -1050], target: [0, -420, -450], fov: 50 },
            ],
            subtitles: [
                { t: 1, speaker: "Lantern Actual", text: "All elements, Firebase Lantern is open. Patrol routes are on your boards.", channel: "radio" },
                { t: 5.2, speaker: "Lantern Eleven", text: "Eleven on station. Light's quiet tonight. Lights are always quiet, until they aren't.", channel: "radio" },
            ],
        },
        {
            id: "firebase", duration: 9, ease: "inOut",
            keys: [
                { t: 0, pos: [fx + 110, -470, fz - 90], target: [fx, -536, fz], fov: 42 },
                { t: 9, pos: [fx + 60, -505, fz - 60], target: [fx, -536, fz + 8], fov: 40 },
            ],
            cards: [{ t: 2.5, dur: 5.5, style: "chapter", lines: ["CHAPTER TWO", "RETALIATION"] }],
            subtitles: [{ t: 1, speaker: CAST2.sage, text: "Firebase Lantern. Built on the landing zone, Lieutenant. I am sorry.", channel: "sage" }],
        },
        {
            id: "alex", duration: 8, ease: "inOut", fadeOut: 0.8,
            keys: [
                { t: 0, follow: "alex", offset: [1.4, 1.7, 2.6], lookOffset: [0, 1.55, 0], fov: 38 },
                { t: 8, follow: "alex", offset: [0.6, 1.66, -0.6], lookOffset: [0, 1.6, 10], fov: 46 },
            ],
            subtitles: [
                { t: 0.6, speaker: CAST2.sage, text: "Cellular repair still at three hundred percent. You should not be standing.", channel: "sage" },
                { t: 4.4, speaker: CAST2.voss, text: "Lieutenant. When you're ready - on me.", channel: "radio" },
            ],
        },
    ],
};

/** The hollow: the wounded skywing, and the hunters who come for it. */
export const HOLLOW: Scene = {
    id: "hollow",
    shots: [
        {
            id: "glow", duration: 7, ease: "inOut", fadeIn: 0.6,
            keys: [
                { t: 0, follow: "kesh", offset: [9, 4, 12], lookOffset: [0, 1.6, 0], fov: 44 },
                { t: 7, follow: "kesh", offset: [6, 3, 9], lookOffset: [0, 2, 1], fov: 40 },
            ],
            subtitles: [
                { t: 0.5, speaker: CAST2.sage, text: "Lieutenant... it is alive.", channel: "sage" },
                { t: 3.2, speaker: "", text: "(a low, broken cry)", channel: "caption" },
            ],
            events: [{ t: 0.2, name: "music", args: { cue: "beast" } }, { t: 3, name: "cry" }],
        },
        {
            id: "wound", duration: 6, ease: "inOut",
            keys: [
                { t: 0, follow: "kesh", offset: [2.6, 3.4, 2.2], lookOffset: [0.5, 2.4, 0.4], fov: 34 },
                { t: 6, follow: "kesh", offset: [2.1, 3.0, 1.4], lookOffset: [0.5, 2.4, 0.4], fov: 30 },
            ],
            subtitles: [{ t: 0.6, speaker: CAST2.sage, text: "A coil slug. Ours. Lantern Four's chin gun - the recorder logged the burst.", channel: "sage" }],
        },
        {
            id: "eyes", duration: 6, ease: "inOut",
            keys: [
                { t: 0, follow: "kesh", offset: [-2.4, 3.6, 5.6], lookOffset: [0, 3.4, 3.2], fov: 30 },
                { t: 6, follow: "kesh", offset: [-1.8, 3.6, 4.9], lookOffset: [0, 3.5, 3.4], fov: 26 },
            ],
            subtitles: [{ t: 0.8, speaker: CAST2.sage, text: "It is looking at you. It knows what the light on your armor means.", channel: "sage" }],
        },
        {
            id: "hunters", duration: 7, ease: "linear",
            keys: [
                { t: 0, follow: "hunter", offset: [-3, 1.8, 7], lookOffset: [0, 1.6, 0], fov: 36 },
                { t: 7, follow: "hunter", offset: [-2, 1.6, 5], lookOffset: [0, 1.7, 0], fov: 32 },
            ],
            subtitles: [
                { t: 0.6, speaker: "Warden", text: "Ashen tharu! Kesh-vael ilm'ae!", channel: "voice" },
                { t: 3.2, speaker: "TRANSLATOR", text: "\"DEFILERS ... YOU TAKE EVEN THE SKY'S ... CHILDREN\" (36%)", channel: "translation" },
            ],
        },
        {
            id: "ready", duration: 4, ease: "inOut", fadeOut: 0.4, shake: 0.12,
            keys: [
                { t: 0, follow: "alex", offset: [-1.1, 1.7, -2.4], lookOffset: [0, 1.5, 10], fov: 48 },
                { t: 4, follow: "alex", offset: [-0.5, 1.66, -0.4], lookOffset: [0, 1.6, 10], fov: 46 },
            ],
            subtitles: [{ t: 0.4, speaker: CAST2.sage, text: "They think you came to finish it.", channel: "sage" }],
            events: [{ t: 0.2, name: "music", args: { cue: "battle" } }],
        },
    ],
};

/** The river's water closes the wound; the skywing stands, and lowers its neck to Alex. */
export const SKYBOUND: Scene = {
    id: "skybound",
    shots: [
        {
            id: "pour", duration: 7, ease: "inOut", fadeIn: 0.5,
            keys: [
                { t: 0, follow: "kesh", offset: [2.8, 3.2, 2.6], lookOffset: [0.5, 2.4, 0.4], fov: 34 },
                { t: 7, follow: "kesh", offset: [2.2, 3.4, 1.6], lookOffset: [0.5, 2.4, 0.4], fov: 30 },
            ],
            subtitles: [{ t: 0.6, speaker: "", text: "(the river's water runs over the wound, and the wound drinks it in)", channel: "caption" }],
            events: [{ t: 0, name: "music", args: { cue: "skybound" } }, { t: 3, name: "healKesh" }],
        },
        {
            id: "rise", duration: 8, ease: "inOut",
            keys: [
                { t: 0, follow: "kesh", offset: [12, 2.5, 10], lookOffset: [0, 3, 0], fov: 48 },
                { t: 8, follow: "kesh", offset: [16, 4, 4], lookOffset: [0, 3.5, 0], fov: 56 },
            ],
            subtitles: [{ t: 1, speaker: CAST2.sage, text: "The tissue is closing. Lieutenant... it is the same as you.", channel: "sage" }],
            events: [{ t: 1.5, name: "keshRise" }, { t: 4, name: "cry" }],
        },
        {
            id: "name", duration: 8, ease: "inOut",
            keys: [
                { t: 0, follow: "kesh", offset: [-2.2, 3.4, 5.2], lookOffset: [0, 3, 2.8], fov: 32 },
                { t: 8, follow: "kesh", offset: [-1.6, 2.6, 4.4], lookOffset: [0, 2.4, 3.0], fov: 30 },
            ],
            subtitles: [{ t: 0.6, speaker: CAST2.sage, text: "{naming}", channel: "sage" }],
            events: [{ t: 1, name: "keshBow" }],
        },
        {
            id: "card", duration: 6, ease: "inOut", fadeOut: 0.8,
            keys: [
                { t: 0, follow: "kesh", offset: [18, 9, -14], lookOffset: [0, 3, 0], fov: 50 },
                { t: 6, follow: "kesh", offset: [22, 14, -18], lookOffset: [0, 3, 0], fov: 50 },
            ],
            cards: [{ t: 0.8, dur: 4.6, style: "chapter", lines: ["THE BEAST BELOW", "KESH"] }],
        },
    ],
};

/** Alex lands at the surface's own base on the back of a creature of the deep. */
export const FIRSTLIGHT: Scene = {
    id: "firstlight",
    shots: [
        {
            id: "base", duration: 8, ease: "inOut",
            keys: [
                { t: 0, follow: "kesh", offset: [24, 6, 26], lookOffset: [0, 3, 0], fov: 44 },
                { t: 8, follow: "kesh", offset: [14, 3, 18], lookOffset: [0, 3, 0], fov: 40 },
            ],
            subtitles: [
                { t: 0.5, speaker: CAST2.sage, text: "Lieutenant. Every rifle on the base is aimed at us.", channel: "sage" },
                { t: 4, speaker: CAST2.voss, text: "Stand down. STAND DOWN. That's our man.", channel: "radio" },
            ],
        },
        {
            id: "rider", duration: 7, ease: "inOut",
            keys: [
                { t: 0, follow: "kesh", offset: [-4, 4.2, 7], lookOffset: [0, 3.5, 0], fov: 36 },
                { t: 7, follow: "kesh", offset: [-3, 3.8, 5.5], lookOffset: [0, 3.6, 0], fov: 32 },
            ],
            subtitles: [{ t: 0.8, speaker: CAST2.voss, text: "Welcome back to the surface, Alex. You're the first thing that's come up out of there that we didn't send down.", channel: "radio" }],
        },
        {
            id: "sky", duration: 10, ease: "inOut", fadeOut: 1.2,
            keys: [
                { t: 0, follow: "kesh", offset: [0, 30, -60], lookOffset: [0, -10, 120], fov: 52 },
                { t: 10, pos: [-400, 180, -900], target: [200, -350, 0], fov: 56 },
            ],
            cards: [
                { t: 1, dur: 4, style: "caption", lines: ["Below, the kingdoms would hear of a surface soldier", "who rode one of the sky's children."] },
                { t: 5.5, dur: 4, style: "chapter", lines: ["CHAPTER TWO", "THE ABYSS IS OPEN"] },
            ],
        },
    ],
};

export const SCENES2: Record<string, Scene> = { aftermath: AFTERMATH, hollow: HOLLOW, skybound: SKYBOUND, firstlight: FIRSTLIGHT };

/** Points Chapter Two can be started from (tests, the chapter menu). */
export type ChapterTwoStart = "open" | "hollow" | "skybound" | "roam";
export const CH2_STARTS: ChapterTwoStart[] = ["open", "hollow", "skybound", "roam"];

/** Where the hunters come from at the hollow (on the ridge north of it). */
export const HUNTERS: { dx: number; dz: number; look: string }[] = [
    { dx: -50, dz: 60, look: "warden-m" }, { dx: 0, dz: 75, look: "adept" }, { dx: 45, dz: 62, look: "warden-f" }, { dx: 70, dz: 30, look: "warden-m" },
];

export const sceneTargets = { firebase: [fx, -536, fz] as V3 };
