// Collectibles: small things from before the Last Day, left on tables and floors along the way.
// Ray can look at one (E), turn it over, read what it is, and keep it or put it back. Each is built
// from a few of the shared shapes (box, cylinder, sphere) with the tiling materials, drawn by the
// ARCH pipeline's solid kind; real models can replace them later without touching the game.

import { MAT, type V3 } from "./te_level";

export type Shape = "box" | "cyl" | "sphere";
/**
 * One piece: `at` is its center (a cylinder's base center), `size` its half extents (a cylinder's
 * radius, height, radius; a sphere's radii), turned by rx / rz (then the item's yaw), meters.
 */
export interface Part { shape: Shape; at: V3; size: V3; mat: number; tint: V3; metal?: number; glow?: number; rx?: number; rz?: number; ry?: number }
export interface Collectible { id: string; name: string; text: string; parts: Part[] }

const BRASS: V3 = [0.86, 0.62, 0.3], COPPER: V3 = [0.8, 0.45, 0.3], IRON: V3 = [0.42, 0.4, 0.38], BONE: V3 = [0.9, 0.86, 0.78], GLASS: V3 = [0.5, 0.85, 1];
const b = (at: V3, size: V3, mat: number, tint: V3, more: Partial<Part> = {}): Part => ({ shape: "box", at, size, mat, tint, ...more });
const c = (at: V3, r: number, h: number, mat: number, tint: V3, more: Partial<Part> = {}): Part => ({ shape: "cyl", at, size: [r, h, r], mat, tint, ...more });
const s = (at: V3, r: number, mat: number, tint: V3, more: Partial<Part> = {}): Part => ({ shape: "sphere", at, size: [r, r, r], mat, tint, ...more });
const M = MAT.metal, W = MAT.wood, P = MAT.marble;

export const COLLECTIBLES: Collectible[] = [
    { id: "pocket-watch", name: "Brass Pocket Watch", text: "Two hands for two clocks: one for Mars, one for the simulation, the second turning 23.33 times as fast. The Virtuous Time Constant, made to fit a pocket. Both stopped on the Last Day.",
        parts: [c([0, 0, 0], 0.045, 0.014, M, BRASS, { metal: 0.9 }), c([0, 0.014, 0], 0.038, 0.002, P, BONE), c([0, 0, 0.05], 0.008, 0.012, M, BRASS, { metal: 0.9 }), b([0, 0.017, 0.012], [0.002, 0.001, 0.022], M, IRON), b([0.01, 0.017, 0], [0.016, 0.001, 0.0015], M, IRON)] },
    { id: "earth-photo", name: "Photograph of Earth", text: "Blue and white, taken from the old lunar gate. On the back, in a careful hand: \"Before Mr. Tiny.\" No one on Mars has seen that color in the sky since.",
        parts: [b([0, 0.08, 0], [0.07, 0.085, 0.008], W, [0.4, 0.28, 0.2]), b([0, 0.08, 0.009], [0.055, 0.068, 0.001], P, [0.25, 0.45, 0.9], { glow: 0.25 }), s([0, 0.08, 0.008], 0.03, P, [0.3, 0.55, 0.95], { glow: 0.3 }), b([0, 0.03, -0.03], [0.006, 0.03, 0.025], W, [0.4, 0.28, 0.2], { rx: 0.5 })] },
    { id: "toy-rover", name: "Toy Rover", text: "A child's six-wheeled rover, the paint worn off its wheels. Robots built the first domes on Mars thousands of years ago; children have been playing at it ever since.",
        parts: [b([0, 0.05, 0], [0.06, 0.022, 0.09], M, [0.75, 0.3, 0.2], { metal: 0.3 }), b([0, 0.085, 0.03], [0.03, 0.015, 0.025], M, BRASS, { metal: 0.8 }), c([0, 0.1, 0.03], 0.004, 0.06, M, IRON),
            ...[-0.07, 0, 0.07].flatMap(z => [-1, 1].map(sx => c([sx * 0.07, 0.03, z], 0.025, 0.018, MAT.asphalt, [0.25, 0.24, 0.22], { rz: Math.PI / 2 })))] },
    { id: "music-box", name: "Music Box", text: "Wind it and it plays four bars of a song from the simulation's first epoch. The comb is missing a tooth, so the same note always drops out.",
        parts: [b([0, 0.045, 0], [0.08, 0.045, 0.055], W, [0.5, 0.3, 0.2]), b([0, 0.095, -0.05], [0.08, 0.05, 0.006], W, [0.5, 0.3, 0.2], { rx: -0.35 }), c([0, 0.09, 0], 0.03, 0.01, M, BRASS, { metal: 0.9 }), c([0.09, 0.045, 0], 0.006, 0.03, M, BRASS, { rz: -Math.PI / 2, metal: 0.9 })] },
    { id: "seed-vial", name: "Seed Vial", text: "Barley, sealed in glass and labeled TERRAFORM LOT 9. The fields that turned the plains red-gold were grown from vials like this one.",
        parts: [c([0, 0, 0], 0.022, 0.13, P, [0.7, 0.9, 0.6], { glow: 0.35 }), c([0, 0.13, 0], 0.024, 0.025, M, BRASS, { metal: 0.9 }), c([0, 0.02, 0], 0.018, 0.07, MAT.soil, [0.95, 0.75, 0.35])] },
    { id: "upload-ticket", name: "Upload Ticket", text: "ADMIT ONE. CENTRAL SPIRE, GATE 4. A passage into the simulation, punched but never used. Someone changed their mind at the door.",
        parts: [b([0, 0.003, 0], [0.075, 0.003, 0.04], P, [0.95, 0.85, 0.6], { glow: 0.12 }), b([0.045, 0.007, 0], [0.012, 0.001, 0.03], M, BRASS, { metal: 0.9 }), c([-0.05, 0.004, 0.015], 0.008, 0.004, MAT.asphalt, [0.1, 0.1, 0.1])] },
    { id: "commuter-pass", name: "Commuter Pass", text: "SPIRE - RELAY, UNLIMITED RIDES. The holder's face has burned out of the hologram. The bridge carried forty thousand people a day.",
        parts: [b([0, 0.004, 0], [0.05, 0.004, 0.032], M, [0.3, 0.32, 0.36], { metal: 0.6 }), b([-0.015, 0.009, 0], [0.018, 0.001, 0.022], P, GLASS, { glow: 0.6 }), b([0.03, 0.009, 0.012], [0.012, 0.001, 0.006], M, BRASS, { metal: 0.9 })] },
    { id: "courier-drone", name: "Courier Drone", text: "A palm-sized delivery drone with one rotor left. Its cargo pouch still holds a message chip too corrupted to read; only the word \"sorry\" survives.",
        parts: [s([0, 0.05, 0], 0.045, M, BRASS, { metal: 0.8 }), ...[0, 1, 2, 3].map(i => b([Math.cos(i * Math.PI / 2 + 0.78) * 0.07, 0.07, Math.sin(i * Math.PI / 2 + 0.78) * 0.07], [0.035, 0.005, 0.008], M, IRON, { ry: -(i * Math.PI / 2 + 0.78) })),
            c([0.12, 0.075, 0.12], 0.04, 0.004, M, IRON), s([0, 0.04, 0.04], 0.012, P, [1, 0.3, 0.2], { glow: 1.2 })] },
    { id: "archivist-badge", name: "Archivist's Badge", text: "RELAY TOWER - MIND ARCHIVE - LEVEL 3. The archivists kept a backup of every uploaded mind. The Error found the backups first.",
        parts: [c([0, 0, 0], 0.04, 0.006, M, BRASS, { metal: 0.9 }), c([0, 0.006, 0], 0.028, 0.002, P, GLASS, { glow: 0.5 }), b([0, 0.004, 0.05], [0.012, 0.003, 0.014], M, COPPER, { metal: 0.8 })] },
    { id: "chess-knight", name: "Chess Knight", text: "Brass, turned by hand. Robots and humans played across the bridge by radio, one move a day. This game was on move 2,113.",
        parts: [c([0, 0, 0], 0.03, 0.02, M, BRASS, { metal: 0.9 }), c([0, 0.02, 0], 0.02, 0.04, M, BRASS, { metal: 0.9 }), b([0, 0.075, 0.008], [0.014, 0.025, 0.022], M, BRASS, { metal: 0.9, rx: 0.4 }), b([0, 0.085, 0.03], [0.011, 0.01, 0.016], M, BRASS, { metal: 0.9 })] },
    { id: "memory-spindle", name: "Memory Spindle", text: "A glass spindle of stored thought, the kind the racks here hold by the thousand. Through your lens it flickers: a kitchen, a voice, a dog's name.",
        parts: [c([0, 0, 0], 0.02, 0.14, P, GLASS, { glow: 0.9 }), c([0, 0, 0], 0.026, 0.018, M, BRASS, { metal: 0.9 }), c([0, 0.122, 0], 0.026, 0.018, M, BRASS, { metal: 0.9 }), c([0, 0.03, 0], 0.008, 0.08, P, [1, 1, 1], { glow: 1.6 })] },
    { id: "child-drawing", name: "Child's Drawing", text: "Crayon on a plastic sheet: a tall robot holding a small human's hand. Both are smiling. The robot has a telescope for a head.",
        parts: [b([0, 0.002, 0], [0.1, 0.002, 0.075], P, [0.95, 0.93, 0.88]), b([-0.03, 0.005, 0], [0.008, 0.001, 0.045], MAT.brick, [0.8, 0.3, 0.2]), c([-0.03, 0.005, 0.05], 0.014, 0.001, M, BRASS), b([0.035, 0.005, -0.02], [0.006, 0.001, 0.025], MAT.brick, [0.3, 0.45, 0.85]), s([0.035, 0.005, 0.012], 0.01, P, [0.95, 0.75, 0.3])] },
    { id: "vault-ledger", name: "Vault Ledger", text: "The last entry: \"Biochip prototype B-7 sealed in the vault. Neurons stable. If the dark comes, it thinks where we can't.\" Signed with one initial: S.",
        parts: [b([0, 0.02, 0], [0.09, 0.02, 0.12], W, [0.3, 0.12, 0.1]), b([0.005, 0.02, 0], [0.085, 0.017, 0.115], P, [0.92, 0.88, 0.78]), b([-0.09, 0.02, 0], [0.006, 0.022, 0.12], M, BRASS, { metal: 0.9 })] },
    { id: "night-lamp", name: "Night Lamp", text: "A tiny nuclear lamp, still glowing after three years in the dark. It was built to burn for a century. It will outlast the people who needed it.",
        parts: [c([0, 0, 0], 0.035, 0.02, M, IRON), s([0, 0.06, 0], 0.035, P, [0.6, 1, 0.6], { glow: 2.2 }), c([0, 0.09, 0], 0.012, 0.02, M, BRASS, { metal: 0.9 }), ...[0, 1, 2].map(i => b([Math.cos(i * 2.1) * 0.035, 0.05, Math.sin(i * 2.1) * 0.035], [0.003, 0.035, 0.003], M, BRASS, { metal: 0.9 }))] },
    { id: "broken-lens", name: "Cracked Telescope Lens", text: "Torn from a robot like you. The ring is etched with a serial number and, smaller, a name its owner chose for itself: Wren.",
        parts: [c([0, 0, 0], 0.06, 0.035, M, BRASS, { metal: 0.9, rx: Math.PI / 2 - 0.2 }), c([0, 0, 0.004], 0.05, 0.034, P, GLASS, { glow: 0.3, rx: Math.PI / 2 - 0.2 }), b([0.02, 0.03, 0.02], [0.03, 0.001, 0.002], P, [1, 1, 1], { glow: 0.6, ry: 0.7 })] },
    { id: "tuning-fork", name: "Tuning Fork", text: "Tuned to the archive's resonance. Technicians struck it against the racks to hear which minds were still whole. It rings true. Something here still is.",
        parts: [b([0, 0.006, 0], [0.006, 0.006, 0.05], M, [0.8, 0.8, 0.82], { metal: 1 }), b([-0.012, 0.006, 0.085], [0.004, 0.005, 0.04], M, [0.8, 0.8, 0.82], { metal: 1 }), b([0.012, 0.006, 0.085], [0.004, 0.005, 0.04], M, [0.8, 0.8, 0.82], { metal: 1 }), b([0, 0.006, 0.048], [0.016, 0.005, 0.004], M, [0.8, 0.8, 0.82], { metal: 1 })] },
    { id: "linesman-glove", name: "Linesman's Glove", text: "Insulated, oversized, burned through at the fingertips. Whoever wore it kept these breakers live long after the evacuation.",
        parts: [b([0, 0.025, 0], [0.06, 0.025, 0.075], MAT.asphalt, [0.75, 0.55, 0.2]), ...[-0.045, -0.015, 0.015, 0.045].map(x => b([x, 0.02, 0.11], [0.012, 0.016, 0.04], MAT.asphalt, [0.75, 0.55, 0.2])), b([0.075, 0.02, 0.02], [0.03, 0.015, 0.012], MAT.asphalt, [0.75, 0.55, 0.2], { ry: -0.6 }), b([0.045, 0.03, 0.15], [0.008, 0.01, 0.006], MAT.soil, [0.1, 0.08, 0.06])] },
    { id: "spray-can", name: "Spray Can", text: "Half empty. On the wall above it, in the same red paint: WE LET THEM IN. The handwriting gets worse further down.",
        parts: [c([0, 0, 0], 0.03, 0.16, M, [0.8, 0.12, 0.1], { metal: 0.6 }), c([0, 0.16, 0], 0.024, 0.02, M, [0.8, 0.8, 0.82], { metal: 1 }), c([0, 0.18, 0], 0.008, 0.012, M, [0.2, 0.2, 0.2])] },
    { id: "dog-tag", name: "Dog Tag", text: "SPIRE GUARD, 7TH WATCH. The guard held these stairs on the Last Day while the Relay emptied. The tag is all of them that left.",
        parts: [b([0, 0.002, 0], [0.028, 0.002, 0.016], M, [0.75, 0.75, 0.78], { metal: 1 }), ...[0, 1, 2, 3, 4, 5].map(i => s([0.035 + i * 0.012, 0.003, 0.004 * Math.sin(i)], 0.004, M, [0.75, 0.75, 0.78], { metal: 1 }))] },
    { id: "postcard-phobos", name: "Postcard from Phobos", text: "\"Wish you were here. The view of home is unreal.\" Mailed the week before the Last Day. It never left the sorting office.",
        parts: [b([0, 0.002, 0], [0.075, 0.002, 0.05], P, [0.9, 0.82, 0.66]), s([-0.025, 0.004, 0.005], 0.022, P, [0.45, 0.42, 0.4], { glow: 0.1 }), b([0.045, 0.005, 0.03], [0.012, 0.001, 0.012], MAT.brick, [0.8, 0.3, 0.25])] },
    { id: "commendation", name: "Commendation Medal", text: "Awarded to a machine, before it was hacked: \"For forty years of service to the Lower Bridge.\" Its owner might still be out there.",
        parts: [c([0, 0, 0], 0.035, 0.005, M, BRASS, { metal: 0.9 }), s([0, 0.006, 0], 0.012, P, [0.9, 0.2, 0.15], { glow: 0.4 }), b([0, 0.002, 0.06], [0.018, 0.002, 0.03], MAT.asphalt, [0.2, 0.3, 0.7])] },
    { id: "engineer-mug", name: "Engineer's Mug", text: "WORLD'S OKAYEST REACTOR TECH. The tea inside dried to a ring three years ago. The reactor was at forty percent when they left.",
        parts: [c([0, 0, 0], 0.04, 0.1, P, [0.92, 0.9, 0.86]), c([0, 0.09, 0], 0.034, 0.008, MAT.soil, [0.35, 0.2, 0.1]), b([0.05, 0.05, 0], [0.012, 0.028, 0.006], P, [0.92, 0.9, 0.86])] },
    { id: "fusion-key", name: "Fusion Key", text: "A start key for the reactor, on a ring with a little brass robot. The second key is missing. Someone wanted to be sure no one could shut it down.",
        parts: [b([0, 0.004, 0], [0.008, 0.004, 0.045], M, [0.8, 0.8, 0.82], { metal: 1 }), c([0, 0, -0.06], 0.02, 0.006, M, [0.8, 0.8, 0.82], { metal: 1 }), b([0.006, 0.004, 0.035], [0.008, 0.004, 0.006], M, [0.8, 0.8, 0.82], { metal: 1 }), b([0.03, 0.012, -0.07], [0.008, 0.012, 0.006], M, BRASS, { metal: 0.9 }), c([0.03, 0.024, -0.07], 0.006, 0.014, M, BRASS, { metal: 0.9 })] },
    { id: "family-holo", name: "Family Hologram", text: "Two humans, a robot and a cat, flickering on a loop. The robot's head is a lens like yours. They are all laughing at something out of frame.",
        parts: [c([0, 0, 0], 0.05, 0.02, M, IRON, { metal: 0.7 }), c([0, 0.02, 0], 0.035, 0.004, P, GLASS, { glow: 1.2 }), b([-0.02, 0.07, 0], [0.012, 0.045, 0.004], P, GLASS, { glow: 0.8 }), b([0.015, 0.06, 0], [0.01, 0.035, 0.004], P, GLASS, { glow: 0.8 }), s([0.035, 0.035, 0], 0.012, P, GLASS, { glow: 0.8 })] },
    // Mission 2, Noctis.
    { id: "field-map", name: "The Doctor's Field Map", text: "Noctis in his hand, in pencil, corrected in ink. Three places circled twice. In the margin: \"If it's true, I knew them. I signed for them.\"",
        parts: [b([0, 0.002, 0], [0.11, 0.002, 0.08], P, [0.88, 0.8, 0.62]), b([-0.03, 0.005, 0.01], [0.04, 0.001, 0.003], MAT.brick, [0.5, 0.25, 0.2], { ry: 0.6 }), c([0.05, 0.004, -0.03], 0.012, 0.002, MAT.brick, [0.7, 0.15, 0.1]), c([-0.06, 0.004, 0.04], 0.012, 0.002, MAT.brick, [0.7, 0.15, 0.1]), b([0.02, 0.006, 0.05], [0.045, 0.003, 0.004], W, [0.7, 0.55, 0.3], { ry: -0.3 })] },
    { id: "doctor-monocle", name: "The Doctor's Monocle", text: "Cracked across, the brass ring bent where someone stood on it. The lens still holds a faint cyan glow, the last thing it was looking at.",
        parts: [c([0, 0.004, 0], 0.03, 0.006, M, BRASS, { metal: 0.9 }), c([0, 0.006, 0], 0.025, 0.003, P, GLASS, { glow: 0.7 }), b([0.006, 0.01, 0.004], [0.022, 0.001, 0.0015], P, [1, 1, 1], { glow: 0.4, ry: 0.8 }), b([0.045, 0.002, 0], [0.02, 0.0015, 0.0015], M, BRASS, { metal: 0.9 })] },
    { id: "work-order", name: "Work Order 911", text: "FOUR THOUSAND AVATAR BODIES. STANDARD FACES. RUSH. Customer: Gate Four Authority. Under special instructions, in a different hand: \"No questions about the occupants.\"",
        parts: [b([0, 0.01, 0], [0.07, 0.01, 0.1], W, [0.4, 0.3, 0.2]), b([0, 0.022, 0.005], [0.062, 0.002, 0.088], P, [0.92, 0.9, 0.82]), b([0, 0.026, 0.09], [0.03, 0.006, 0.008], M, [0.75, 0.75, 0.78], { metal: 1 })] },
    { id: "avatar-mask", name: "Unfinished Face", text: "A blank porcelain face from the line, never fitted. Turn it to the light and the mold shows through: someone's cheekbones, someone's chin. They were printing the dead from their uploads.",
        parts: [s([0, 0.04, 0], 0.06, P, [0.94, 0.92, 0.88]), b([0, 0.04, -0.03], [0.065, 0.065, 0.03], P, [0.94, 0.92, 0.88]), b([-0.02, 0.05, 0.05], [0.012, 0.004, 0.006], MAT.asphalt, [0.1, 0.1, 0.1]), b([0.02, 0.05, 0.05], [0.012, 0.004, 0.006], MAT.asphalt, [0.1, 0.1, 0.1]), b([0.01, 0.07, 0.055], [0.002, 0.03, 0.002], MAT.asphalt, [0.3, 0.3, 0.3], { rz: 0.4 })] },
    { id: "queue-token", name: "Queue Token 4011", text: "Brass, stamped GATE FOUR, NOW SERVING. The last number called was 4011. This one is 4012. Whoever held it was next in line when the gate opened the other way.",
        parts: [c([0, 0, 0], 0.03, 0.005, M, BRASS, { metal: 0.9 }), c([0, 0.005, 0], 0.022, 0.001, M, COPPER, { metal: 0.9 }), c([0.025, 0.002, 0], 0.005, 0.006, M, IRON)] },
    { id: "hymn-cylinder", name: "Hymn Cylinder", text: "A wax cylinder from a cherub's music box. The gate's hymn: a lullaby for the people in the queue, to keep them calm while they waited to see their dead.",
        parts: [c([0, 0, 0], 0.025, 0.1, P, [0.75, 0.55, 0.3]), c([0, -0.005, 0], 0.012, 0.11, M, BRASS, { metal: 0.9 }), c([0, 0.1, 0], 0.027, 0.006, M, BRASS, { metal: 0.9 })] },
    { id: "visitor-ribbon", name: "Visitor's Ribbon", text: "Pinned to visitors after a session so the staff knew to be gentle. Embroidered: I SAW THEM TODAY. Thousands were handed out. Nobody pinned on the ones who came back out.",
        parts: [b([0, 0.002, 0], [0.012, 0.002, 0.05], P, [0.3, 0.45, 0.9], { glow: 0.1 }), b([0.012, 0.002, -0.05], [0.012, 0.002, 0.02], P, [0.3, 0.45, 0.9], { ry: 0.5 }), c([0, 0.004, 0.05], 0.014, 0.004, M, BRASS, { metal: 0.9 })] },
    { id: "captains-log", name: "Captain's Log, Patience", text: "Last entry: \"Cargo: meltwater, ninety thousand tons. Something on the radio wearing my brother's voice. Holding course. Broadcasting warnings. Tell them not to open the gates.\"",
        parts: [b([0, 0.015, 0], [0.08, 0.015, 0.11], W, [0.25, 0.15, 0.1]), b([0, 0.016, 0], [0.075, 0.012, 0.105], P, [0.85, 0.8, 0.68]), c([0.08, 0.015, 0], 0.01, 0.03, M, BRASS, { metal: 0.9, rx: Math.PI / 2 })] },
    { id: "meltwater-flask", name: "Meltwater Flask", text: "Pole ice, still sealed. The Patience carried enough to make a lake. This much would keep one family for a week. It is the cleanest thing in the canyon.",
        parts: [c([0, 0, 0], 0.035, 0.12, P, [0.7, 0.9, 1], { glow: 0.25 }), c([0, 0.12, 0], 0.016, 0.03, M, [0.8, 0.8, 0.82], { metal: 1 }), c([0, 0.04, 0], 0.037, 0.03, MAT.asphalt, [0.3, 0.25, 0.2])] },
    { id: "ration-tin", name: "Ration Tin", text: "Scratched into the lid with a nail, one line per night: ninety-one lines. On the inside, a child's handwriting: PIP SAYS WE WILL BE OKAY.",
        parts: [c([0, 0, 0], 0.045, 0.06, M, [0.55, 0.5, 0.42], { metal: 0.7 }), c([0, 0.06, 0], 0.046, 0.006, M, [0.6, 0.55, 0.45], { metal: 0.8 }), b([0, 0.067, 0], [0.03, 0.001, 0.002], MAT.asphalt, [0.2, 0.2, 0.2])] },
    { id: "brass-crown", name: "Harvest Crown", text: "Pulled from an empty pod. Sixty needle contacts on the inside, still warm. The Error never wanted the bodies. It wanted what was asleep in them.",
        parts: [c([0, 0, 0], 0.07, 0.03, M, BRASS, { metal: 0.9 }), c([0, 0.002, 0], 0.062, 0.028, MAT.asphalt, [0.08, 0.07, 0.07]), ...[0, 1, 2, 3, 4, 5].map(i => c([Math.cos(i * 1.047) * 0.07, 0.03, Math.sin(i * 1.047) * 0.07], 0.006, 0.04, M, BRASS, { metal: 0.9 })), s([0, 0.03, 0.07], 0.01, P, [1, 0.2, 0.1], { glow: 1 })] },
    { id: "tithe-ledger", name: "The Tithe's Ledger", text: "Columns of trades. NIGHT 112: TWO SLEEPERS, ONE NIGHT WITHOUT A RAID. NIGHT 113: ONE CHILD (REFUSED). At the bottom, newer: \"A Reborn would cover a year.\"",
        parts: [b([0, 0.02, 0], [0.085, 0.02, 0.12], W, [0.2, 0.25, 0.15]), b([0.004, 0.02, 0], [0.08, 0.017, 0.115], P, [0.9, 0.85, 0.72]), b([-0.085, 0.02, 0.05], [0.006, 0.022, 0.012], M, IRON)] },
    { id: "metro-token", name: "Metro Token", text: "UNDERCROFT LINE, ONE FARE. The line ran under the canyon to the old mines. When the Error came, people rode it down to hide. The trains are still here. The people are in the pit.",
        parts: [c([0, 0, 0], 0.022, 0.004, M, COPPER, { metal: 0.9 }), c([0, 0.004, 0], 0.008, 0.001, MAT.asphalt, [0.1, 0.1, 0.1])] },
    { id: "dust-goggles", name: "Dust Goggles", text: "A canyon runner's goggles, one lens cracked. A strip of tape on the strap: PROPERTY OF THE TITHE. LOSE THEM AND YOU WALK HOME BLIND.",
        parts: [c([-0.035, 0.02, 0], 0.025, 0.02, M, BRASS, { metal: 0.9, rx: Math.PI / 2 }), c([0.035, 0.02, 0], 0.025, 0.02, M, BRASS, { metal: 0.9, rx: Math.PI / 2 }), c([-0.035, 0.02, 0.011], 0.02, 0.002, P, [0.9, 0.6, 0.3], { glow: 0.2, rx: Math.PI / 2 }), c([0.035, 0.02, 0.011], 0.02, 0.002, P, [0.9, 0.6, 0.3], { glow: 0.2, rx: Math.PI / 2 }), b([0, 0.02, -0.01], [0.09, 0.006, 0.004], MAT.asphalt, [0.2, 0.15, 0.1])] },
    { id: "turbine-plate", name: "Turbine Plate", text: "TERRAFORM WIND ARRAY, UNIT 31. COMMISSIONED BY THE ROBOTS OF THARSIS FOR THEIR HUMAN NEIGHBORS. For a thousand years it made the air. Now it only turns when the storms come.",
        parts: [b([0, 0.003, 0], [0.08, 0.003, 0.05], M, BRASS, { metal: 0.9 }), b([0, 0.007, 0], [0.065, 0.001, 0.035], M, [0.5, 0.35, 0.2], { metal: 0.6 }), ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => c([x * 0.072, 0.003, z * 0.042], 0.004, 0.006, M, IRON))] },
];

export const COLLECTIBLE = new Map(COLLECTIBLES.map(c => [c.id, c]));

type M3 = number[];
const mul3 = (a: M3, q: M3): M3 => {
    const o = new Array(9).fill(0);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) o[c * 3 + r] += a[k * 3 + r] * q[c * 3 + k];
    return o;
};
const rotY = (a: number): M3 => [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): M3 => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const rotX = (a: number): M3 => [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)];
export const IDENTITY3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** A tumble for the inspect view: turned by yaw about +y, then pitch about +x. */
export const tumble = (yaw: number, pitch: number): M3 => mul3(rotX(pitch), rotY(yaw));

/**
 * A part's model matrix with the item at `origin`, turned by `yaw` and scaled by `k`; `frame` turns
 * the whole item about its origin first (the inspect view's tumble).
 */
export function partMatrix(part: Part, origin: V3, yaw: number, k = 1, frame: M3 = IDENTITY3): number[] {
    const placeR = mul3(frame, rotY(yaw));
    const R = mul3(placeR, mul3(rotY(part.ry ?? 0), mul3(rotZ(part.rz ?? 0), rotX(part.rx ?? 0))));
    const a = part.at;
    const off: V3 = [0, 1, 2].map(r => (placeR[r] * a[0] + placeR[3 + r] * a[1] + placeR[6 + r] * a[2]) * k) as V3;
    const [sx, sy, sz] = part.size.map(v => v * k);
    return [R[0] * sx, R[1] * sx, R[2] * sx, 0, R[3] * sy, R[4] * sy, R[5] * sy, 0, R[6] * sz, R[7] * sz, R[8] * sz, 0, origin[0] + off[0], origin[1] + off[1], origin[2] + off[2], 1];
}

/** The shape key of the shared mesh a part draws with (te_render.ts SHAPES). */
export const shapeKey = (p: Part) => (p.shape === "cyl" ? "cyl" : p.shape === "sphere" ? "sphere" : "box");
