// ARMAGEDDON 2070 - the design database as game data.
//
// Every row of the v0.1 design database (docs/armageddon/v0.1/*.csv) is here with its ID, name
// and status kept, and every TBD replaced by a value on one shared balance scale (BALANCE below).
// `tools/ar_export_csv.ts` writes these tables back out as Design Database v0.2
// (docs/armageddon/v0.2/*.csv), so the CSVs and the game never disagree.
//
// The scale:
//   health      a soldier has 100 HP; vehicles and mecha are in the same HP
//   damage      HP per hit at point blank, falling linearly to `minDamage` at effective range
//   protection  0..1: the share of a hit's damage a piece of armor stops (before penetration)
//   distance    metres; speed km/h in tables, m/s in the simulation
//   time        seconds; rate of fire in rounds per minute
//   weight      kilograms; a soldier carries 18 kg before slowing down
//   signature   1.0 = an ordinary soldier; lower is harder to see (visual), feel (thermal), hear (noise)

export type Status = "Proposed" | "Concept" | "Added v0.2";

export const BALANCE = {
    soldierHp: 100,
    /** Carried weight with no speed penalty, and the weight at which speed bottoms out. */
    freeLoad: 18, maxLoad: 70,
    /** Speed at the full penalty, as a share of normal. */
    minSpeedShare: 0.55,
    walk: 2.0, run: 4.6, sprint: 6.6, crouch: 2.2, prone: 0.9,
    /** Hit locations: share of hits and damage multiplier. */
    head: { share: 0.1, mult: 2.0 }, torso: { share: 0.45, mult: 1.0 }, arms: { share: 0.2, mult: 0.75 }, legs: { share: 0.25, mult: 0.8 },
    /** Bots see an ordinary standing, moving soldier this far (m), scaled by signature. */
    sightRange: 190,
    /** Bot rounds (bullets and pellets) deal this share of their damage to a human player. */
    botVsPlayer: 0.8,
    /** Respawn delay (s), the Conquer rule: "all players may respawn within 5 seconds". */
    respawn: 5,
    /** Seconds of uncontested presence to flip a territory, per capturing soldier (diminishing). */
    capture: 16,
    /** Reinforcement tickets per team per battle. */
    tickets: 1600,
    /** A team holding more territories drains the other this many tickets per extra territory per 10 s. */
    drain: 2,
    /** Underdog: seconds in the bottom quarter of the team leaderboard to earn one reward. */
    underdogSeconds: 150,
    underdogShare: 0.25,
    teamSize: 128,
    squadSize: 8,
} as const;

// --- weapons --------------------------------------------------------------------------------

export type WeaponSlot = "Primary" | "Heavy" | "Sidearm" | "Launcher" | "Special";
export interface Weapon {
    id: string; name: string; category: string; slot: WeaponSlot; damageType: string;
    damage: number; minDamage: number; range: number; rpm: number; mag: number; reload: number;
    /** Degrees of muzzle climb per shot (Recoil_Profile is this with a word). */
    recoil: number; recoilWord: string;
    weight: number;
    /** Hip spread and aimed spread, degrees. */
    hip: number; aim: number;
    pellets: number;
    /** Damage to vehicles per hit (0: small arms do armor-scaled `damage`). */
    vsVehicle: number;
    /** Projectile speed m/s (0: hitscan). Splash radius for explosives. */
    speed: number; splash: number;
    /** Guided: seconds to lock (0: unguided), and what it locks: ground or air. */
    lock: number; locks: "" | "ground" | "air";
    /** Spare magazines carried. */
    spare: number;
    /** Optic slots and other attachment slots this weapon accepts. */
    slots: string[];
    /** Needs a bipod deployed or a heavy exoskeleton to fire well (unbraced it still fires, wildly). */
    heavy?: boolean;
    /** How the trigger works for the player: auto fires while held; semi, bolt, pump and single fire once per pull. */
    action: "auto" | "semi" | "bolt" | "pump" | "single";
    /** Magnification when aiming down the weapon's own sights (a fitted optic replaces it). */
    sight: number;
    description: string; status: Status;
}

const W = (o: Omit<Weapon, "pellets" | "vsVehicle" | "speed" | "splash" | "lock" | "locks" | "slots" | "action" | "sight"> & Partial<Weapon>): Weapon =>
    ({ pellets: 1, vsVehicle: 0, speed: 0, splash: 0, lock: 0, locks: "", slots: ["Optic", "Muzzle", "Barrel", "Underbarrel", "Magazine", "Utility"], action: "semi", sight: 1.3, ...o });

export const WEAPONS: Weapon[] = [
    W({ id: "W001", name: "AR-70", category: "Assault Rifle", slot: "Primary", damageType: "Ballistic", damage: 25, minDamage: 18, range: 300, rpm: 750, mag: 30, reload: 2.3, recoil: 0.45, recoilWord: "Moderate vertical", weight: 3.6, hip: 2.4, aim: 0.12, spare: 6, action: "auto", description: "Standard issue assault rifle; baseline infantry weapon", status: "Proposed" }),
    W({ id: "W002", name: "AR-70C", category: "Compact Assault Rifle", slot: "Primary", damageType: "Ballistic", damage: 23, minDamage: 15, range: 180, rpm: 850, mag: 30, reload: 2.1, recoil: 0.5, recoilWord: "Fast, moderate", weight: 3.0, hip: 1.9, aim: 0.18, spare: 6, action: "auto", description: "Compact variant optimized for close quarters", status: "Proposed" }),
    W({ id: "W003", name: "BR-71", category: "Battle Rifle", slot: "Primary", damageType: "Ballistic", damage: 38, minDamage: 30, range: 450, rpm: 450, mag: 20, reload: 2.6, recoil: 0.9, recoilWord: "Heavy vertical", weight: 4.4, hip: 3.0, aim: 0.08, spare: 5, description: "Higher-powered rifle for medium-to-long engagements", status: "Proposed" }),
    W({ id: "W004", name: "SMG-70", category: "Submachine Gun", slot: "Primary", damageType: "Ballistic", damage: 20, minDamage: 11, range: 90, rpm: 950, mag: 35, reload: 1.9, recoil: 0.3, recoilWord: "Light, jittery", weight: 2.6, hip: 1.4, aim: 0.3, spare: 6, action: "auto", description: "Close-quarters automatic weapon", status: "Proposed" }),
    W({ id: "W005", name: "SG-70", category: "Shotgun", slot: "Primary", damageType: "Ballistic", damage: 14, minDamage: 3, range: 30, rpm: 75, mag: 7, reload: 3.6, recoil: 2.5, recoilWord: "Heavy kick", weight: 3.4, hip: 3.2, aim: 2.2, pellets: 9, spare: 4, slots: ["Optic", "Barrel", "Magazine", "Utility"], action: "pump", description: "Close-quarters weapon with strong short-range stopping power", status: "Proposed" }),
    W({ id: "W006", name: "LMG-72", category: "Light Machine Gun", slot: "Primary", damageType: "Ballistic", damage: 26, minDamage: 19, range: 350, rpm: 700, mag: 100, reload: 5.5, recoil: 0.55, recoilWord: "Steady, wanders", weight: 7.8, hip: 3.6, aim: 0.2, spare: 3, action: "auto", description: "Squad suppression and sustained fire", status: "Proposed" }),
    W({ id: "W007", name: "HMG-75", category: "Heavy Machine Gun", slot: "Heavy", damageType: "Ballistic", damage: 45, minDamage: 38, range: 900, rpm: 550, mag: 100, reload: 7.0, recoil: 1.2, recoilWord: "Severe unless deployed", weight: 38, hip: 6, aim: 0.15, vsVehicle: 30, spare: 2, heavy: true, slots: ["Optic", "Underbarrel"], action: "auto", description: "Heavy support weapon; likely requires deployment or high strength", status: "Proposed" }),
    W({ id: "W008", name: "SR-70", category: "Sniper Rifle", slot: "Primary", damageType: "Ballistic", damage: 95, minDamage: 80, range: 1000, rpm: 50, mag: 5, reload: 3.2, recoil: 3.0, recoilWord: "Single heavy kick", weight: 7.0, hip: 5, aim: 0.02, spare: 5, action: "bolt", description: "Long-range precision rifle", status: "Proposed" }),
    W({ id: "W009", name: "DMR-71", category: "Designated Marksman Rifle", slot: "Primary", damageType: "Ballistic", damage: 48, minDamage: 40, range: 600, rpm: 220, mag: 15, reload: 2.5, recoil: 1.3, recoilWord: "Sharp vertical", weight: 4.9, hip: 3.5, aim: 0.05, spare: 5, description: "Semi-automatic precision weapon for medium and long range", status: "Proposed" }),
    W({ id: "W010", name: "AMR-76", category: "Anti-Materiel Rifle", slot: "Heavy", damageType: "Ballistic", damage: 160, minDamage: 140, range: 1500, rpm: 40, mag: 5, reload: 4.2, recoil: 4.5, recoilWord: "Brutal", weight: 14, hip: 7, aim: 0.03, vsVehicle: 140, spare: 3, heavy: true, slots: ["Optic", "Muzzle", "Underbarrel"], action: "bolt", description: "Heavy precision weapon intended to threaten equipment and light vehicles", status: "Proposed" }),
    W({ id: "W011", name: "P-70", category: "Pistol", slot: "Sidearm", damageType: "Ballistic", damage: 30, minDamage: 18, range: 50, rpm: 400, mag: 15, reload: 1.4, recoil: 0.6, recoilWord: "Snappy", weight: 0.9, hip: 1.6, aim: 0.35, spare: 3, slots: ["Optic", "Muzzle", "Magazine", "Utility"], sight: 1.2, description: "Standard sidearm", status: "Proposed" }),
    W({ id: "W012", name: "MP-70", category: "Machine Pistol", slot: "Sidearm", damageType: "Ballistic", damage: 18, minDamage: 9, range: 40, rpm: 1100, mag: 25, reload: 1.6, recoil: 0.4, recoilWord: "Climbs fast", weight: 1.4, hip: 1.8, aim: 0.45, spare: 3, slots: ["Muzzle", "Magazine"], action: "auto", sight: 1.15, description: "Automatic sidearm for close-range defense", status: "Proposed" }),
    W({ id: "W013", name: "AT-Disposable-70", category: "Disposable Anti-Tank Launcher", slot: "Launcher", damageType: "Explosive", damage: 70, minDamage: 70, range: 250, rpm: 30, mag: 1, reload: 1.5, recoil: 2, recoilWord: "Backblast", weight: 6.0, hip: 2.5, aim: 0.3, vsVehicle: 650, speed: 160, splash: 3, spare: 1, slots: [], action: "single", sight: 1.5, description: "Single-use anti-vehicle launcher; two tubes are carried", status: "Concept" }),
    W({ id: "W014", name: "AT-Reusable-70", category: "Reusable Anti-Vehicle Launcher", slot: "Launcher", damageType: "Guided/Explosive", damage: 80, minDamage: 80, range: 600, rpm: 10, mag: 1, reload: 4.5, recoil: 2, recoilWord: "Backblast", weight: 12, hip: 2.5, aim: 0.2, vsVehicle: 800, speed: 130, splash: 3, lock: 1.2, locks: "ground", spare: 3, slots: ["Optic"], action: "single", sight: 2, description: "Reloadable launcher for anti-armor operations", status: "Concept" }),
    W({ id: "W015", name: "AA-70", category: "Guided Anti-Air Launcher", slot: "Launcher", damageType: "Guided", damage: 60, minDamage: 60, range: 1200, rpm: 10, mag: 1, reload: 5, recoil: 1.5, recoilWord: "Backblast", weight: 14, hip: 3, aim: 0.3, vsVehicle: 900, speed: 320, splash: 4, lock: 2.0, locks: "air", spare: 2, slots: [], action: "single", sight: 2.5, description: "Shoulder-fired anti-air system", status: "Concept" }),
    W({ id: "W016", name: "EMR-70", category: "Electromagnetic Rifle", slot: "Special", damageType: "Electromagnetic", damage: 70, minDamage: 62, range: 800, rpm: 120, mag: 8, reload: 3.0, recoil: 1.6, recoilWord: "Recoilless but heavy", weight: 6.5, hip: 3, aim: 0.04, vsVehicle: 90, spare: 4, slots: ["Optic", "Utility"], description: "Advanced weapon; role and balance to be determined. v0.2: rail slug that pierces cover up to 0.5 m and stuns vehicle electronics for 1.5 s", status: "Concept" }),
];

/** The Underbarrel Grenade Launcher (A015) as a weapon: it takes the launcher slot (3) when no launcher is
 * carried. Not a database row (Attachments.csv holds it); 4 HE grenades, 90 HP within 5 m. */
export const UGL: Weapon = W({ id: "A015", name: "UGL-40", category: "Underbarrel Grenade Launcher", slot: "Launcher", damageType: "Explosive", damage: 90, minDamage: 90, range: 300, rpm: 40, mag: 1, reload: 2.2, recoil: 1.8, recoilWord: "Thump", weight: 0, hip: 2.5, aim: 0.4, vsVehicle: 120, speed: 75, splash: 5, spare: 3, slots: [], action: "single", sight: 1.4, description: "40 mm HE grenades in an arc", status: "Concept" });

// --- attachments ----------------------------------------------------------------------------

export interface Attachment {
    id: string; name: string; slot: string; compatibility: string; weight: number;
    /** Multipliers: time to aim down sights, and recoil. */
    aimTime: number; recoil: number;
    /** Optic magnification (1 = none), and multipliers on spread, range, detection by others, magazine. */
    zoom: number; spread: number; range: number; signature: number; mag: number;
    /** Which weapon categories take it (by weapon id). */
    fits: string[];
    description: string; status: Status;
}
const rifles = ["W001", "W002", "W003", "W006", "W008", "W009", "W016"];
const smallArms = ["W001", "W002", "W003", "W004", "W005", "W006", "W009", "W011", "W012"];
const firearms = ["W001", "W002", "W003", "W004", "W005", "W006", "W007", "W008", "W009", "W010", "W011", "W012", "W016"];
const A = (o: Omit<Attachment, "zoom" | "spread" | "range" | "signature" | "mag"> & Partial<Attachment>): Attachment => ({ zoom: 1, spread: 1, range: 1, signature: 1, mag: 1, ...o });

export const ATTACHMENTS: Attachment[] = [
    A({ id: "A001", name: "Iron Sights", slot: "Optic", compatibility: "Any compatible rifle", weight: 0, aimTime: 1.0, recoil: 1.0, zoom: 1.3, fits: firearms, description: "Baseline sight; no electronic signature", status: "Proposed" }),
    A({ id: "A002", name: "Red Dot Sight", slot: "Optic", compatibility: "Compatible small arms", weight: 0.15, aimTime: 0.92, recoil: 1.0, zoom: 1.4, spread: 0.9, fits: smallArms, description: "Fast close-to-medium range aiming", status: "Proposed" }),
    A({ id: "A003", name: "Holographic Sight", slot: "Optic", compatibility: "Compatible small arms", weight: 0.3, aimTime: 0.88, recoil: 1.0, zoom: 1.45, spread: 0.9, fits: smallArms, description: "Open sight picture for rapid target acquisition", status: "Proposed" }),
    A({ id: "A004", name: "2x Combat Optic", slot: "Optic", compatibility: "Compatible rifles", weight: 0.45, aimTime: 1.1, recoil: 1.0, zoom: 2, spread: 0.85, fits: rifles, description: "Low magnification for general-purpose engagements", status: "Proposed" }),
    A({ id: "A005", name: "4x Optic", slot: "Optic", compatibility: "Compatible rifles", weight: 0.6, aimTime: 1.25, recoil: 1.0, zoom: 4, spread: 0.75, fits: rifles, description: "Medium magnification", status: "Proposed" }),
    A({ id: "A006", name: "8x Precision Optic", slot: "Optic", compatibility: "Compatible precision rifles", weight: 0.9, aimTime: 1.45, recoil: 1.0, zoom: 8, spread: 0.6, fits: ["W008", "W009", "W010", "W016", "W003"], description: "High magnification; narrower situational awareness", status: "Proposed" }),
    A({ id: "A007", name: "Suppressor", slot: "Muzzle", compatibility: "Compatible firearms", weight: 0.5, aimTime: 1.05, recoil: 0.92, range: 0.85, signature: 0.45, fits: firearms.filter(w => w !== "W005" && w !== "W007"), description: "Reduces muzzle report and detection range; may reduce performance", status: "Proposed" }),
    A({ id: "A008", name: "Compensator", slot: "Muzzle", compatibility: "Compatible firearms", weight: 0.25, aimTime: 1.0, recoil: 0.78, signature: 1.2, fits: firearms, description: "Reduces recoil; may increase muzzle signature", status: "Proposed" }),
    A({ id: "A009", name: "Flash Hider", slot: "Muzzle", compatibility: "Compatible firearms", weight: 0.15, aimTime: 1.0, recoil: 0.95, signature: 0.8, fits: firearms, description: "Reduces visible muzzle flash", status: "Proposed" }),
    A({ id: "A010", name: "Short Barrel", slot: "Barrel", compatibility: "Compatible firearms", weight: -0.4, aimTime: 0.85, recoil: 1.08, range: 0.8, spread: 1.15, fits: ["W001", "W002", "W003", "W004", "W005", "W006", "W009"], description: "Improves handling; may reduce velocity and range", status: "Proposed" }),
    A({ id: "A011", name: "Extended Barrel", slot: "Barrel", compatibility: "Compatible firearms", weight: 0.5, aimTime: 1.12, recoil: 0.95, range: 1.25, spread: 0.85, fits: ["W001", "W002", "W003", "W005", "W006", "W008", "W009"], description: "May improve velocity and range; increases weight and handling time", status: "Proposed" }),
    A({ id: "A012", name: "Heavy Barrel", slot: "Barrel", compatibility: "Compatible firearms", weight: 0.9, aimTime: 1.15, recoil: 0.8, range: 1.1, spread: 0.9, fits: ["W001", "W003", "W006", "W009"], description: "Improves sustained-fire stability; adds weight", status: "Proposed" }),
    A({ id: "A013", name: "Vertical Foregrip", slot: "Underbarrel", compatibility: "Compatible firearms", weight: 0.2, aimTime: 1.03, recoil: 0.82, fits: ["W001", "W002", "W003", "W004", "W005", "W006", "W009"], description: "Improves recoil control; adds weight", status: "Proposed" }),
    A({ id: "A014", name: "Bipod", slot: "Underbarrel", compatibility: "Compatible support weapons", weight: 0.4, aimTime: 1.05, recoil: 0.55, spread: 0.7, fits: ["W006", "W007", "W008", "W009", "W010", "W003"], description: "Improves stability when deployed (crouched or prone)", status: "Proposed" }),
    A({ id: "A015", name: "Underbarrel Grenade Launcher", slot: "Underbarrel", compatibility: "Selected assault rifles", weight: 1.4, aimTime: 1.1, recoil: 0.95, fits: ["W001", "W003"], description: "Adds limited indirect explosive capability: 4 HE grenades, 90 HP within 5 m", status: "Concept" }),
    A({ id: "A016", name: "Extended Magazine", slot: "Magazine", compatibility: "Compatible firearms", weight: 0.35, aimTime: 1.06, recoil: 1.0, mag: 1.5, fits: ["W001", "W002", "W003", "W004", "W005", "W009", "W011", "W012"], description: "Increases ammunition capacity; may slow handling", status: "Proposed" }),
    A({ id: "A017", name: "Laser Designator", slot: "Utility", compatibility: "Compatible firearms", weight: 0.2, aimTime: 1.0, recoil: 1.0, spread: 0.8, signature: 1.3, fits: firearms, description: "Aiming aid; may reveal position to sensors. Paints targets for airstrikes", status: "Concept" }),
    A({ id: "A018", name: "Weapon Flashlight", slot: "Utility", compatibility: "Compatible firearms", weight: 0.15, aimTime: 1.0, recoil: 1.0, signature: 1.25, fits: firearms, description: "Illuminates dark areas; visible when active", status: "Proposed" }),
    A({ id: "A019", name: "Rangefinder", slot: "Utility", compatibility: "Selected optics", weight: 0.25, aimTime: 1.0, recoil: 1.0, spread: 0.9, fits: ["W003", "W008", "W009", "W010", "W016"], description: "Provides distance estimate; shows bullet drop on the reticle", status: "Concept" }),
];

// --- armor ----------------------------------------------------------------------------------

export type ArmorSlot = "Helmet" | "Chest" | "Shoulders" | "Arms" | "Legs" | "Utility" | "Exoskeleton" | "Finish";
export interface Armor {
    id: string; name: string; slot: ArmorSlot; armorClass: string; weight: number;
    ballistic: number; explosive: number; visual: number; thermal: number; noise: number;
    /** Exoskeletons: kilograms of load they carry for you. Chest rigs: inventory points. */
    offsets: number; inventory: number;
    description: string; status: Status;
}
const AR = (o: Omit<Armor, "offsets" | "inventory"> & Partial<Armor>): Armor => ({ offsets: 0, inventory: 0, ...o });

export const ARMOR: Armor[] = [
    AR({ id: "AR001", name: "Scout Helmet", slot: "Helmet", armorClass: "Scout", weight: 0.8, ballistic: 0.25, explosive: 0.1, visual: 0.92, thermal: 0.95, noise: 0.95, description: "Low-profile head protection", status: "Proposed" }),
    AR({ id: "AR002", name: "Standard Helmet", slot: "Helmet", armorClass: "Standard", weight: 1.4, ballistic: 0.4, explosive: 0.2, visual: 1.0, thermal: 1.0, noise: 1.0, description: "General-purpose head protection", status: "Proposed" }),
    AR({ id: "AR003", name: "Heavy Helmet", slot: "Helmet", armorClass: "Heavy", weight: 2.6, ballistic: 0.6, explosive: 0.35, visual: 1.12, thermal: 1.05, noise: 1.05, description: "Enhanced head protection with weight and visibility trade-offs", status: "Proposed" }),
    AR({ id: "AR004", name: "Light Chest Rig", slot: "Chest", armorClass: "Scout/Light", weight: 2.5, ballistic: 0.15, explosive: 0.1, visual: 0.92, thermal: 0.95, noise: 0.9, inventory: 6, description: "Minimal torso protection and limited storage", status: "Proposed" }),
    AR({ id: "AR005", name: "Standard Plate Carrier", slot: "Chest", armorClass: "Standard", weight: 7, ballistic: 0.4, explosive: 0.3, visual: 1.0, thermal: 1.0, noise: 1.0, inventory: 8, description: "Balanced torso protection and storage", status: "Proposed" }),
    AR({ id: "AR006", name: "Heavy Composite Chest Plate", slot: "Chest", armorClass: "Heavy", weight: 14, ballistic: 0.6, explosive: 0.5, visual: 1.2, thermal: 1.1, noise: 1.3, inventory: 10, description: "High protection with significant weight", status: "Proposed" }),
    AR({ id: "AR007L", name: "Shoulder Armor Set (Light)", slot: "Shoulders", armorClass: "Light", weight: 0.8, ballistic: 0.12, explosive: 0.1, visual: 0.98, thermal: 1.0, noise: 1.0, description: "Modular shoulder protection", status: "Proposed" }),
    AR({ id: "AR007S", name: "Shoulder Armor Set (Standard)", slot: "Shoulders", armorClass: "Standard", weight: 1.6, ballistic: 0.25, explosive: 0.2, visual: 1.03, thermal: 1.0, noise: 1.02, description: "Modular shoulder protection", status: "Proposed" }),
    AR({ id: "AR007H", name: "Shoulder Armor Set (Heavy)", slot: "Shoulders", armorClass: "Heavy", weight: 3.2, ballistic: 0.4, explosive: 0.3, visual: 1.08, thermal: 1.02, noise: 1.05, description: "Modular shoulder protection", status: "Proposed" }),
    AR({ id: "AR008L", name: "Arm Guards (Light)", slot: "Arms", armorClass: "Light", weight: 0.6, ballistic: 0.12, explosive: 0.08, visual: 0.98, thermal: 1.0, noise: 1.0, description: "Modular arm protection", status: "Proposed" }),
    AR({ id: "AR008S", name: "Arm Guards (Standard)", slot: "Arms", armorClass: "Standard", weight: 1.2, ballistic: 0.25, explosive: 0.15, visual: 1.02, thermal: 1.0, noise: 1.02, description: "Modular arm protection", status: "Proposed" }),
    AR({ id: "AR008H", name: "Arm Guards (Heavy)", slot: "Arms", armorClass: "Heavy", weight: 2.4, ballistic: 0.4, explosive: 0.25, visual: 1.06, thermal: 1.02, noise: 1.05, description: "Modular arm protection", status: "Proposed" }),
    AR({ id: "AR009L", name: "Leg Guards (Light)", slot: "Legs", armorClass: "Light", weight: 1.0, ballistic: 0.12, explosive: 0.1, visual: 0.98, thermal: 1.0, noise: 1.0, description: "Modular leg protection", status: "Proposed" }),
    AR({ id: "AR009S", name: "Leg Guards (Standard)", slot: "Legs", armorClass: "Standard", weight: 2.0, ballistic: 0.25, explosive: 0.2, visual: 1.02, thermal: 1.0, noise: 1.04, description: "Modular leg protection", status: "Proposed" }),
    AR({ id: "AR009H", name: "Leg Guards (Heavy)", slot: "Legs", armorClass: "Heavy", weight: 4.0, ballistic: 0.4, explosive: 0.3, visual: 1.06, thermal: 1.02, noise: 1.1, description: "Modular leg protection", status: "Proposed" }),
    AR({ id: "AR010", name: "Thermal-Dampening Cloak", slot: "Utility", armorClass: "Scout/Light", weight: 3, ballistic: 0, explosive: -0.05, visual: 0.85, thermal: 0.3, noise: 0.95, description: "Reduces thermal signature at a cost to durability or mobility", status: "Concept" }),
    AR({ id: "AR011", name: "Powered Exoskeleton Frame", slot: "Exoskeleton", armorClass: "Assault", weight: 9, ballistic: 0.05, explosive: 0.05, visual: 1.1, thermal: 1.25, noise: 1.2, offsets: 22, description: "Supports heavy equipment and may offset carried load", status: "Concept" }),
    AR({ id: "AR012", name: "Heavy Exoskeleton Frame", slot: "Exoskeleton", armorClass: "Heavy Assault", weight: 18, ballistic: 0.1, explosive: 0.1, visual: 1.35, thermal: 1.5, noise: 1.6, offsets: 48, description: "High-load frame; loud and visually conspicuous. Lets an HMG-75 or AMR-76 fire undeployed", status: "Concept" }),
    AR({ id: "AR013", name: "Mimetic Plate Coating", slot: "Finish", armorClass: "Any", weight: 2.5, ballistic: 0.03, explosive: 0, visual: 0.62, thermal: 0.9, noise: 1.0, description: "Adaptive pigment layer over plates: heavier and a little stronger, much harder to see", status: "Added v0.2" }),
    AR({ id: "AR014", name: "Biome Camouflage Finish", slot: "Finish", armorClass: "Any", weight: 0.3, ballistic: 0, explosive: 0, visual: 0.8, thermal: 1.0, noise: 1.0, description: "Printed pattern matched to the map's ground", status: "Added v0.2" }),
];

// --- ammunition, equipment ------------------------------------------------------------------

export interface Ammo { id: string; name: string; type: string; damage: number; penetration: number; vsArmor: number; signature: number; range: number; description: string; status: Status }
export const AMMO: Ammo[] = [
    { id: "AM001", name: "Standard Ball", type: "Ballistic", damage: 1.0, penetration: 0.2, vsArmor: 1, signature: 1, range: 1, description: "General-purpose ammunition", status: "Proposed" },
    { id: "AM002", name: "Armor-Piercing", type: "Ballistic", damage: 0.9, penetration: 0.6, vsArmor: 1, signature: 1, range: 1.05, description: "Improved penetration; possible trade-off against unarmored targets", status: "Concept" },
    { id: "AM003", name: "Hollow-Point", type: "Ballistic", damage: 1.2, penetration: 0, vsArmor: 0.65, signature: 1, range: 0.9, description: "Potentially higher effect against unarmored targets; reduced armor performance", status: "Concept" },
    { id: "AM004", name: "Subsonic", type: "Ballistic", damage: 0.9, penetration: 0.15, vsArmor: 1, signature: 0.6, range: 0.8, description: "Reduced report and velocity; range and damage trade-offs", status: "Concept" },
    { id: "AM005", name: "Tracer", type: "Ballistic", damage: 1.0, penetration: 0.2, vsArmor: 1, signature: 1.4, range: 1, description: "Visible trajectory for observation and fire correction (tighter aimed spread)", status: "Proposed" },
    { id: "AM006", name: "High-Explosive", type: "Explosive", damage: 1.0, penetration: 0, vsArmor: 1, signature: 1, range: 1, description: "Explosive payload for compatible launchers", status: "Proposed" },
    { id: "AM007", name: "Smoke", type: "Special", damage: 0, penetration: 0, vsArmor: 1, signature: 1, range: 1, description: "Creates visual obscuration", status: "Proposed" },
    { id: "AM008", name: "EMP", type: "Electromagnetic", damage: 0.3, penetration: 0, vsArmor: 1, signature: 1, range: 1, description: "Disrupts compatible electronic targets", status: "Concept" },
];

export interface Equipment {
    id: string; name: string; category: string; deployment: string; weight: number;
    /** Inventory points (a chest rig holds 6-10). */
    cost: number;
    /** Uses carried; damage or effect; radius m; duration s; health of a deployable. */
    uses: number; effect: number; radius: number; duration: number; hp: number;
    description: string; status: Status;
}
export const EQUIPMENT: Equipment[] = [
    { id: "E001", name: "Anti-Personnel Mine", category: "Mine", deployment: "Deployable", weight: 0.8, cost: 1, uses: 2, effect: 110, radius: 4, duration: 240, hp: 1, description: "Infantry area denial; seen within 6 m, disarmed with a Repair Tool in 3 s", status: "Proposed" },
    { id: "E002", name: "Anti-Vehicle Mine", category: "Mine", deployment: "Deployable", weight: 6, cost: 3, uses: 1, effect: 1800, radius: 3, duration: 300, hp: 1, description: "Vehicle area denial; ignores infantry; friendly vehicles pass safely", status: "Proposed" },
    { id: "E003", name: "Fragmentation Grenade", category: "Grenade", deployment: "Throwable", weight: 0.4, cost: 1, uses: 2, effect: 120, radius: 7, duration: 3.2, hp: 0, description: "General-purpose explosive", status: "Proposed" },
    { id: "E004", name: "Smoke Grenade", category: "Grenade", deployment: "Throwable", weight: 0.35, cost: 1, uses: 2, effect: 0, radius: 8, duration: 18, hp: 0, description: "Visual concealment; thermal sights see through it", status: "Proposed" },
    { id: "E005", name: "EMP Grenade", category: "Grenade", deployment: "Throwable", weight: 0.5, cost: 2, uses: 1, effect: 0, radius: 10, duration: 6, hp: 0, description: "Short-range disruption of electronic systems", status: "Concept" },
    { id: "E006", name: "Medical Kit", category: "Medical", deployment: "Carried", weight: 1.2, cost: 2, uses: 4, effect: 60, radius: 3, duration: 3, hp: 0, description: "Heals 60 HP to self or a squad mate within 3 m over 3 s", status: "Proposed" },
    { id: "E007", name: "Repair Tool", category: "Engineering", deployment: "Carried", weight: 2.5, cost: 2, uses: 1, effect: 90, radius: 4, duration: 0, hp: 0, description: "Repairs vehicles and selected deployables at 90 HP/s; disarms mines", status: "Proposed" },
    { id: "E008", name: "Portable Ammo Crate", category: "Supply", deployment: "Deployable", weight: 6, cost: 3, uses: 1, effect: 6, radius: 6, duration: 120, hp: 200, description: "Six full resupplies for soldiers within 6 m", status: "Proposed" },
    { id: "E009", name: "Deployable Cover", category: "Fortification", deployment: "Deployable", weight: 9, cost: 3, uses: 1, effect: 0, radius: 1.3, duration: 300, hp: 450, description: "A 2.6 m wide, 1.2 m high ballistic shield wall", status: "Concept" },
    { id: "E010", name: "Automatic Turret", category: "Fortification", deployment: "Deployable", weight: 14, cost: 4, uses: 1, effect: 18, radius: 120, duration: 120, hp: 400, description: "Automated defensive LMG; fires at the nearest enemy infantry in sight", status: "Concept" },
    { id: "E011", name: "Recon Beacon", category: "Recon", deployment: "Deployable", weight: 1.5, cost: 2, uses: 1, effect: 0, radius: 45, duration: 90, hp: 60, description: "Spots enemies within 45 m for the whole squad", status: "Concept" },
];

// --- vehicles and mecha ---------------------------------------------------------------------

export type Domain = "Ground" | "Air";
export interface Gun {
    name: string; damage: number; vsVehicle: number; rpm: number; range: number; splash: number; speed: number;
    ammo: number; reload: number;
    /** Locks: guided munitions (ATGM, AA missile). */
    locks?: "ground" | "air";
    /** Indirect (artillery) or dropped (bombs). */
    indirect?: boolean; dropped?: boolean;
    /** Seat that fires it (0 driver/pilot, 1 gunner). */
    seat: number;
}
export interface Vehicle {
    id: string; name: string; domain: Domain; seats: number; seatsLabel: string; role: string; size: string;
    hp: number;
    /** Share of small-arms damage stopped (0..1); explosives use `explosiveArmor`. */
    armor: number; explosiveArmor: number;
    topSpeed: number; armament: string; energy: string;
    guns: Gun[];
    /** Game shape: length, width, height (m). Turn rate rad/s, acceleration m/s^2. */
    dims: [number, number, number]; turn: number; accel: number;
    /** Respawn at base (s) and how many a team may field at once. */
    respawn: number; perTeam: number;
    /** Smoke launchers / flares charges. */
    countermeasures: number;
    /** Which WIR network drives it when a bot is in the driver's seat. */
    wir: "tank" | "apc" | "heli" | "jet" | "none";
    description: string; status: Status;
}
const gun = (o: Partial<Gun> & Pick<Gun, "name" | "damage" | "rpm" | "range">): Gun => ({ vsVehicle: 0, splash: 0, speed: 0, ammo: 200, reload: 4, seat: 1, ...o });
const MG = (seat = 1): Gun => gun({ name: "HMG", damage: 45, vsVehicle: 30, rpm: 550, range: 800, ammo: 200, reload: 6, seat });

export const VEHICLES: Vehicle[] = [
    { id: "V001", name: "Scout Buggy", domain: "Ground", seats: 2, seatsLabel: "2", role: "Reconnaissance", size: "Light", hp: 800, armor: 0.2, explosiveArmor: 0, topSpeed: 120, armament: "Pintle LMG", energy: "Fusion cell (no refuel in Conquer)", guns: [gun({ name: "LMG", damage: 26, rpm: 700, range: 350, ammo: 300, reload: 5 })], dims: [3.6, 2.0, 1.6], turn: 1.6, accel: 7, respawn: 30, perTeam: 6, countermeasures: 0, wir: "apc", description: "Fast reconnaissance vehicle", status: "Proposed" },
    { id: "V002", name: "Armored Jeep", domain: "Ground", seats: 4, seatsLabel: "4", role: "Squad Mobility", size: "Light", hp: 1200, armor: 0.55, explosiveArmor: 0.1, topSpeed: 105, armament: "Roof HMG", energy: "Fusion cell (no refuel in Conquer)", guns: [MG()], dims: [4.8, 2.3, 2.0], turn: 1.3, accel: 5, respawn: 30, perTeam: 6, countermeasures: 0, wir: "apc", description: "Protected light transport", status: "Proposed" },
    { id: "V003", name: "Armored Personnel Carrier", domain: "Ground", seats: 8, seatsLabel: "8 (driver, gunner, 6 troops)", role: "Troop Transport", size: "Medium", hp: 2400, armor: 0.88, explosiveArmor: 0.25, topSpeed: 80, armament: "HMG remote weapon station; smoke", energy: "Fusion cell (no refuel in Conquer)", guns: [MG()], dims: [7.0, 3.0, 2.6], turn: 0.9, accel: 3, respawn: 45, perTeam: 4, countermeasures: 2, wir: "apc", description: "Protected squad transport", status: "Proposed" },
    { id: "V004", name: "Infantry Fighting Vehicle", domain: "Ground", seats: 8, seatsLabel: "8 (driver, gunner, 6 troops)", role: "Infantry Support", size: "Medium", hp: 2900, armor: 0.9, explosiveArmor: 0.3, topSpeed: 70, armament: "30 mm autocannon, 2 ATGM, coax MG, smoke", energy: "Fusion cell (no refuel in Conquer)", guns: [gun({ name: "30mm", damage: 60, vsVehicle: 110, rpm: 200, range: 1000, splash: 2, ammo: 120, reload: 5 }), gun({ name: "ATGM", damage: 80, vsVehicle: 900, rpm: 6, range: 1200, splash: 3, speed: 140, ammo: 2, reload: 12, locks: "ground" })], dims: [6.8, 3.2, 2.8], turn: 0.85, accel: 2.8, respawn: 60, perTeam: 4, countermeasures: 2, wir: "apc", description: "Armed troop carrier with infantry support role", status: "Proposed" },
    { id: "V005", name: "Main Battle Tank", domain: "Ground", seats: 3, seatsLabel: "3 (driver, gunner, commander MG)", role: "Heavy Armor", size: "Heavy", hp: 4200, armor: 0.96, explosiveArmor: 0.45, topSpeed: 65, armament: "130 mm cannon, coax MG, commander HMG, smoke", energy: "Fusion cell (no refuel in Conquer)", guns: [gun({ name: "130mm", damage: 160, vsVehicle: 1100, rpm: 8, range: 1600, splash: 6, speed: 900, ammo: 30, reload: 0, seat: 0 }), gun({ name: "Coax MG", damage: 26, rpm: 700, range: 600, ammo: 500, reload: 6, seat: 0 }), MG(1)], dims: [9.2, 3.7, 2.6], turn: 0.7, accel: 2.4, respawn: 75, perTeam: 3, countermeasures: 2, wir: "tank", description: "Primary heavy direct-fire platform", status: "Proposed" },
    { id: "V006", name: "Tank Destroyer", domain: "Ground", seats: 2, seatsLabel: "2", role: "Anti-Armor", size: "Heavy", hp: 3000, armor: 0.92, explosiveArmor: 0.35, topSpeed: 75, armament: "140 mm rail cannon (casemate, limited traverse), smoke", energy: "Fusion cell (no refuel in Conquer)", guns: [gun({ name: "140mm rail", damage: 120, vsVehicle: 1450, rpm: 6, range: 2000, splash: 3, speed: 1600, ammo: 24, reload: 0, seat: 0 })], dims: [8.4, 3.5, 2.2], turn: 0.75, accel: 2.6, respawn: 75, perTeam: 2, countermeasures: 2, wir: "tank", description: "Specialized anti-vehicle platform", status: "Proposed" },
    { id: "V007", name: "Mobile Anti-Air Vehicle", domain: "Ground", seats: 3, seatsLabel: "3", role: "Air Defense", size: "Medium", hp: 2600, armor: 0.86, explosiveArmor: 0.25, topSpeed: 70, armament: "Twin 35 mm flak, 8 AA missiles", energy: "Fusion cell (no refuel in Conquer)", guns: [gun({ name: "35mm flak", damage: 55, vsVehicle: 120, rpm: 600, range: 1400, splash: 4, ammo: 400, reload: 6, seat: 0 }), gun({ name: "AA missile", damage: 60, vsVehicle: 1000, rpm: 12, range: 2500, splash: 5, speed: 400, ammo: 8, reload: 15, locks: "air", seat: 0 })], dims: [7.4, 3.2, 3.0], turn: 0.85, accel: 2.8, respawn: 60, perTeam: 2, countermeasures: 2, wir: "tank", description: "Mobile defense against aircraft and drones", status: "Proposed" },
    { id: "V008", name: "Self-Propelled Artillery", domain: "Ground", seats: 3, seatsLabel: "3", role: "Indirect Fire", size: "Heavy", hp: 2950, armor: 0.82, explosiveArmor: 0.2, topSpeed: 55, armament: "155 mm howitzer (indirect, on squad markers)", energy: "Fusion cell (no refuel in Conquer)", guns: [gun({ name: "155mm", damage: 220, vsVehicle: 700, rpm: 6, range: 1400, splash: 12, ammo: 40, reload: 0, seat: 0, indirect: true })], dims: [9.5, 3.5, 3.2], turn: 0.6, accel: 2, respawn: 90, perTeam: 1, countermeasures: 2, wir: "tank", description: "Long-range fire support", status: "Concept" },
    { id: "V009", name: "Logistics Truck", domain: "Ground", seats: 4, seatsLabel: "4", role: "Supply", size: "Medium", hp: 1700, armor: 0.45, explosiveArmor: 0.05, topSpeed: 90, armament: "None; resupplies soldiers and vehicles within 15 m", energy: "Fusion cell (no refuel in Conquer)", guns: [], dims: [7.5, 2.6, 3.0], turn: 1.0, accel: 3, respawn: 45, perTeam: 2, countermeasures: 0, wir: "apc", description: "Carries ammunition and field supplies", status: "Proposed" },
    { id: "V010", name: "Recovery Vehicle", domain: "Ground", seats: 3, seatsLabel: "3", role: "Repair/Recovery", size: "Heavy", hp: 3500, armor: 0.88, explosiveArmor: 0.3, topSpeed: 50, armament: "Roof MG; repairs vehicles within 10 m at 60 HP/s", energy: "Fusion cell (no refuel in Conquer)", guns: [MG()], dims: [8.0, 3.4, 2.8], turn: 0.7, accel: 2, respawn: 60, perTeam: 1, countermeasures: 2, wir: "apc", description: "Recovers or repairs damaged vehicles", status: "Concept" },
    { id: "V011", name: "Scout Drone", domain: "Air", seats: 0, seatsLabel: "0 (remote)", role: "Reconnaissance", size: "Small", hp: 120, armor: 0, explosiveArmor: 0, topSpeed: 160, armament: "None; spots enemies within 70 m", energy: "Battery, 90 s sortie", guns: [], dims: [1.2, 1.2, 0.4], turn: 2.5, accel: 15, respawn: 40, perTeam: 4, countermeasures: 0, wir: "heli", description: "Uncrewed surveillance platform", status: "Proposed" },
    { id: "V012", name: "Attack Drone", domain: "Air", seats: 0, seatsLabel: "0 (remote)", role: "Precision Attack", size: "Small", hp: 200, armor: 0, explosiveArmor: 0, topSpeed: 180, armament: "2 ATGM, light MG", energy: "Battery, 90 s sortie", guns: [gun({ name: "ATGM", damage: 80, vsVehicle: 700, rpm: 10, range: 700, splash: 3, speed: 150, ammo: 2, reload: 0, seat: 0, locks: "ground" }), gun({ name: "LMG", damage: 22, rpm: 600, range: 300, ammo: 200, reload: 0, seat: 0 })], dims: [1.6, 1.6, 0.5], turn: 2.5, accel: 15, respawn: 60, perTeam: 2, countermeasures: 0, wir: "heli", description: "Uncrewed attack platform", status: "Concept" },
    { id: "V013", name: "Attack Helicopter", domain: "Air", seats: 2, seatsLabel: "2 (pilot, gunner)", role: "Air Support", size: "Medium", hp: 3100, armor: 0.7, explosiveArmor: 0.15, topSpeed: 290, armament: "30 mm chain gun, 16 rockets, 4 ATGM, flares", energy: "Fusion turbine (no refuel in Conquer)", guns: [gun({ name: "30mm chain gun", damage: 55, vsVehicle: 90, rpm: 600, range: 900, splash: 2, ammo: 300, reload: 6 }), gun({ name: "Rockets", damage: 120, vsVehicle: 400, rpm: 300, range: 900, splash: 5, speed: 300, ammo: 16, reload: 12, seat: 0 }), gun({ name: "ATGM", damage: 80, vsVehicle: 900, rpm: 6, range: 1500, splash: 3, speed: 160, ammo: 4, reload: 15, locks: "ground" })], dims: [15, 3.2, 4.0], turn: 1.1, accel: 7, respawn: 90, perTeam: 2, countermeasures: 3, wir: "heli", description: "Armed helicopter for close air support", status: "Proposed" },
    { id: "V014", name: "Transport Helicopter", domain: "Air", seats: 8, seatsLabel: "8 (pilot, 2 door gunners, 5 troops)", role: "Troop Transport", size: "Large", hp: 3350, armor: 0.6, explosiveArmor: 0.1, topSpeed: 260, armament: "2 door HMGs, flares", energy: "Fusion turbine (no refuel in Conquer)", guns: [MG(1), MG(2)], dims: [17, 3.4, 4.6], turn: 0.9, accel: 6, respawn: 60, perTeam: 3, countermeasures: 3, wir: "heli", description: "Squad transport helicopter", status: "Proposed" },
    { id: "V015", name: "Heavy Transport Helicopter", domain: "Air", seats: 16, seatsLabel: "16 (pilot, 2 door gunners, 13 troops)", role: "Troop Transport", size: "Very Large", hp: 4950, armor: 0.65, explosiveArmor: 0.15, topSpeed: 240, armament: "2 door HMGs, flares", energy: "Fusion turbine (no refuel in Conquer)", guns: [MG(1), MG(2)], dims: [27, 4.2, 5.8], turn: 0.6, accel: 4, respawn: 90, perTeam: 1, countermeasures: 4, wir: "heli", description: "Heavy lift troop transport (tandem rotors)", status: "Proposed" },
    { id: "V016", name: "Fighter", domain: "Air", seats: 1, seatsLabel: "1", role: "Air Superiority", size: "Medium", hp: 2800, armor: 0.5, explosiveArmor: 0.05, topSpeed: 1900, armament: "27 mm cannon, 4 air-to-air missiles, flares", energy: "Fusion turbofan (no refuel in Conquer)", guns: [gun({ name: "27mm", damage: 45, vsVehicle: 100, rpm: 1700, range: 900, ammo: 300, reload: 8, seat: 0 }), gun({ name: "AAM", damage: 60, vsVehicle: 1200, rpm: 30, range: 2500, splash: 6, speed: 600, ammo: 4, reload: 20, seat: 0, locks: "air" })], dims: [17, 12, 4.5], turn: 1.4, accel: 25, respawn: 90, perTeam: 1, countermeasures: 4, wir: "jet", description: "Fast aircraft focused on air-to-air combat", status: "Proposed" },
    { id: "V017", name: "Attack Aircraft", domain: "Air", seats: 1, seatsLabel: "1", role: "Ground Attack", size: "Large", hp: 3750, armor: 0.75, explosiveArmor: 0.2, topSpeed: 750, armament: "30 mm rotary cannon, 6 bombs, 8 rockets, flares", energy: "Fusion turbofan (no refuel in Conquer)", guns: [gun({ name: "30mm rotary", damage: 60, vsVehicle: 150, rpm: 3000, range: 1100, splash: 2, ammo: 400, reload: 10, seat: 0 }), gun({ name: "Bombs", damage: 300, vsVehicle: 1500, rpm: 60, range: 300, splash: 14, ammo: 6, reload: 30, seat: 0, dropped: true }), gun({ name: "Rockets", damage: 120, vsVehicle: 400, rpm: 300, range: 900, splash: 5, speed: 320, ammo: 8, reload: 15, seat: 0 })], dims: [17, 18, 4.8], turn: 1.0, accel: 14, respawn: 120, perTeam: 1, countermeasures: 4, wir: "jet", description: "Fixed-wing close air support platform", status: "Proposed" },
    { id: "V018", name: "Heavy Transport Aircraft", domain: "Air", seats: 3, seatsLabel: "Crew 3 (+ one vehicle payload)", role: "Vehicle Delivery", size: "Very Large", hp: 8000, armor: 0.6, explosiveArmor: 0.15, topSpeed: 550, armament: "None; flares. Air-drops one ground vehicle (up to 70 t) on a marked point", energy: "Fusion turbofan (no refuel in Conquer)", guns: [], dims: [44, 50, 12], turn: 0.4, accel: 6, respawn: 150, perTeam: 1, countermeasures: 6, wir: "jet", description: "Can deliver a compatible vehicle as payload", status: "Proposed" },
];

export interface Mecha {
    id: string; name: string; role: string; weight: number;
    /** Component HP: legs, left arm, right arm, torso (core). Total is the mecha's armor. */
    parts: { legs: number; left: number; right: number; torso: number };
    armor: number; topSpeed: number;
    primary: string; secondary: string; power: string; special: string;
    guns: { left: Gun; right: Gun; shoulder: Gun };
    description: string; status: Status;
}
export const MECHA: Mecha[] = [
    { id: "M001", name: "M-70 Titan", role: "Heavy Assault", weight: 62, parts: { legs: 2200, left: 1300, right: 1300, torso: 3000 }, armor: 0.97, topSpeed: 38, primary: "Twin 105 mm arm cannons", secondary: "24-cell missile pod (shoulder)", power: "Compact fusion core", special: "Shoulder shield: brace to halve frontal damage", guns: { left: gun({ name: "105mm L", damage: 140, vsVehicle: 800, rpm: 15, range: 1200, splash: 5, speed: 800, ammo: 40, reload: 0, seat: 0 }), right: gun({ name: "105mm R", damage: 140, vsVehicle: 800, rpm: 15, range: 1200, splash: 5, speed: 800, ammo: 40, reload: 0, seat: 0 }), shoulder: gun({ name: "Missile pod", damage: 100, vsVehicle: 350, rpm: 240, range: 900, splash: 5, speed: 220, ammo: 24, reload: 20, seat: 0 }) }, description: "Heavy assault platform with cannons and missiles", status: "Proposed" },
    { id: "M002", name: "M-71 Wraith", role: "Recon/Ambush", weight: 34, parts: { legs: 1300, left: 800, right: 800, torso: 1800 }, armor: 0.92, topSpeed: 58, primary: "Rail lance (right arm)", secondary: "Chain gun (left arm)", power: "Compact fusion core", special: "Optical camouflage while still; jump jets", guns: { left: gun({ name: "Chain gun", damage: 50, vsVehicle: 80, rpm: 700, range: 700, ammo: 600, reload: 0, seat: 0 }), right: gun({ name: "Rail lance", damage: 200, vsVehicle: 1300, rpm: 10, range: 1800, speed: 2000, ammo: 20, reload: 0, seat: 0 }), shoulder: gun({ name: "Smoke dischargers", damage: 0, rpm: 6, range: 30, ammo: 6, reload: 0, seat: 0 }) }, description: "Mobile low-signature platform focused on scouting and precision attacks", status: "Proposed" },
    { id: "M003", name: "M-72 Bastion", role: "Defense/Support", weight: 80, parts: { legs: 2800, left: 1500, right: 1500, torso: 3800 }, armor: 0.98, topSpeed: 28, primary: "Quad HMG turrets (arms)", secondary: "120 mm mortar battery (shoulder)", power: "Twin fusion cores", special: "Deployable shield dome (12 m) blocks small arms", guns: { left: gun({ name: "Quad HMG L", damage: 45, vsVehicle: 35, rpm: 1400, range: 900, ammo: 1200, reload: 0, seat: 0 }), right: gun({ name: "Quad HMG R", damage: 45, vsVehicle: 35, rpm: 1400, range: 900, ammo: 1200, reload: 0, seat: 0 }), shoulder: gun({ name: "Mortars", damage: 160, vsVehicle: 400, rpm: 30, range: 1000, splash: 10, ammo: 30, reload: 0, seat: 0, indirect: true }) }, description: "Heavily protected platform for area defense and suppression", status: "Proposed" },
];
/** Only one mecha per side may be on the field. It unlocks when a team holds this many territories, or when its tickets fall this far behind. */
export const MECHA_RULE = { oneAtATime: true, territoriesToUnlock: 0.5, behindBy: 300, respawn: 120 };

// --- rewards --------------------------------------------------------------------------------

export type RewardId = "R001" | "R002" | "R003" | "R004" | "R005" | "R006" | "R007" | "R101" | "R102" | "R103" | "R104" | "R105" | "R106" | "R107" | "R108" | "R109";
export interface Reward {
    id: RewardId; name: string; type: "Killstreak" | "Underdog";
    /** Killstreak: kills without dying. Underdog: seconds in the bottom quarter of the leaderboard. */
    requirement: number;
    effect: string; payload: string; cooldown: number;
    /** Gameplay numbers: radius m, duration s, count, chance. */
    radius: number; duration: number; count: number; chance: number;
    counterplay: string; status: Status;
}
export const REWARDS: Reward[] = [
    { id: "R001", name: "Recon Drone", type: "Killstreak", requirement: 3, effect: "Temporary local enemy detection", payload: "Spots enemies within 120 m for 30 s", cooldown: 60, radius: 120, duration: 30, count: 1, chance: 1, counterplay: "Can be countered by concealment or electronic warfare: thermal cloaks and EMP hide you from it", status: "Proposed" },
    { id: "R002", name: "Supply Drop", type: "Killstreak", requirement: 4, effect: "Delivers ammunition and supplies", payload: "One crate: full ammo, grenades and 100 HP for everyone within 8 m, 3 uses", cooldown: 60, radius: 8, duration: 60, count: 3, chance: 1, counterplay: "Drop location may be contested", status: "Proposed" },
    { id: "R003", name: "Combat Drone", type: "Killstreak", requirement: 5, effect: "Temporary AI aerial support", payload: "AI attack drone for 45 s (WIR helicopter network)", cooldown: 90, radius: 0, duration: 45, count: 1, chance: 1, counterplay: "Vulnerable to anti-air and electronic warfare", status: "Proposed" },
    { id: "R004", name: "Artillery Strike", type: "Killstreak", requirement: 7, effect: "Area bombardment", payload: "10 shells in 25 m over 6 s after a 3 s warning", cooldown: 120, radius: 25, duration: 6, count: 10, chance: 1, counterplay: "Warning and counterplay recommended: a red ring marks the area for 3 s", status: "Proposed" },
    { id: "R005", name: "Attack Helicopter", type: "Killstreak", requirement: 9, effect: "Temporary aerial fire support", payload: "AI attack helicopter for 60 s", cooldown: 150, radius: 0, duration: 60, count: 1, chance: 1, counterplay: "Can be engaged by anti-air systems", status: "Proposed" },
    { id: "R006", name: "Tactical Airstrike", type: "Killstreak", requirement: 12, effect: "Precision bombardment", payload: "4 guided bombs along a 60 m line", cooldown: 150, radius: 14, duration: 2, count: 4, chance: 1, counterplay: "Requires target designation: the line must be in the caller's sight", status: "Proposed" },
    { id: "R007", name: "Hunter Protocol", type: "Killstreak", requirement: 15, effect: "Attempts to neutralize up to 16 targets in a designated field; proposed 80% per-target success", payload: "16 seeker bolts into a 60 m field after 2 s; each neutralizes its target with 80% chance", cooldown: 240, radius: 60, duration: 2, count: 16, chance: 0.8, counterplay: "Targets under a roof, in smoke or in a thermal cloak halve the chance; AA vehicles within 150 m shoot down 1 bolt per second", status: "Concept" },
    { id: "R101", name: "Mine Kit", type: "Underdog", requirement: 150, effect: "Deploys 16 mines in one kit", payload: "16 mines (12 anti-personnel, 4 anti-vehicle) in an arc, line or ring", cooldown: 0, radius: 18, duration: 300, count: 16, chance: 1, counterplay: "Mines are seen within 6 m and disarmed with a Repair Tool; they expire after 300 s", status: "Proposed" },
    { id: "R102", name: "Emergency Ammunition", type: "Underdog", requirement: 150, effect: "Restocks ammunition", payload: "Full ammo, launchers and grenades, now", cooldown: 0, radius: 0, duration: 0, count: 1, chance: 1, counterplay: "One use", status: "Concept" },
    { id: "R103", name: "Reinforcement Squad", type: "Underdog", requirement: 150, effect: "Deploys an AI infantry reinforcement squad", payload: "8 soldiers (proposed) who follow your calls for 120 s", cooldown: 0, radius: 0, duration: 120, count: 8, chance: 1, counterplay: "May exceed the team cap by 8; one per team at a time", status: "Concept" },
    { id: "R104", name: "Field Repair Kit", type: "Underdog", requirement: 150, effect: "Repairs eligible vehicles", payload: "1500 HP to the vehicle you are in or next to, over 8 s", cooldown: 0, radius: 6, duration: 8, count: 1, chance: 1, counterplay: "Interrupted if the vehicle moves", status: "Concept" },
    { id: "R105", name: "Portable Turret", type: "Underdog", requirement: 150, effect: "Deploys an automated defensive weapon", payload: "1 turret: 600 HP, HMG, 150 s", cooldown: 0, radius: 150, duration: 150, count: 1, chance: 1, counterplay: "Fires only at what it can see; explosives kill it fast", status: "Concept" },
    { id: "R106", name: "Anti-Armor Kit", type: "Underdog", requirement: 150, effect: "Provides specialized anti-vehicle equipment", payload: "3 AT-Disposable-70 and 2 anti-vehicle mines", cooldown: 0, radius: 0, duration: 0, count: 5, chance: 1, counterplay: "Weighs 30 kg", status: "Concept" },
    { id: "R107", name: "Emergency Recon", type: "Underdog", requirement: 150, effect: "Temporary enemy detection", payload: "Every enemy within 220 m shown for 20 s", cooldown: 0, radius: 220, duration: 20, count: 1, chance: 1, counterplay: "Thermal cloaks hide you from it", status: "Concept" },
    { id: "R108", name: "EMP Charge", type: "Underdog", requirement: 150, effect: "Disrupts nearby electronic equipment", payload: "30 m pulse: vehicles stall, drones fall, optics and minimaps go dark for 8 s", cooldown: 0, radius: 30, duration: 8, count: 1, chance: 1, counterplay: "Affects your own side too", status: "Concept" },
    { id: "R109", name: "Emergency Extraction", type: "Underdog", requirement: 150, effect: "Calls a transport vehicle to a designated pickup point", payload: "An AI transport helicopter lands at the point, waits 15 s, flies to your nearest territory", cooldown: 0, radius: 12, duration: 15, count: 1, chance: 1, counterplay: "The landing zone must be open; it waves off under heavy AA", status: "Concept" },
];
export const KILLSTREAKS = REWARDS.filter(r => r.type === "Killstreak");
export const UNDERDOG = REWARDS.filter(r => r.type === "Underdog");

// --- squads, WIR modules --------------------------------------------------------------------

export type Role = "leader" | "rifleman" | "support" | "medic" | "engineer" | "marksman" | "antiarmor" | "recon";
export interface Squad { id: string; name: string; size: number; organization: string; roles: Role[]; primaryRole: string; commands: string; notes: string; status: Status }
export const SQUADS: Squad[] = [
    { id: "S001", name: "Standard Infantry Squad", size: 8, organization: "1 squad leader + 2 fireteams of 4 (proposed)", roles: ["leader", "rifleman", "support", "medic", "rifleman", "antiarmor", "engineer", "marksman"], primaryRole: "Cohesion with local autonomy", commands: "Follow; Move; Attack; Defend; Hold Fire; Engage Freely; Regroup; Enter Vehicle; Exit Vehicle", notes: "Squad generally stays together but may split to maneuver", status: "Proposed" },
    { id: "S002", name: "Recon Squad", size: 8, organization: "Leader, 3 marksmen, 2 recon (beacons, drones), 1 medic, 1 engineer", roles: ["leader", "marksman", "marksman", "recon", "recon", "marksman", "medic", "engineer"], primaryRole: "Stealth and information gathering", commands: "Follow; Recon Area; Mark Target; Hold Position; Regroup", notes: "Prioritizes concealment and observation", status: "Concept" },
    { id: "S003", name: "Support Squad", size: 8, organization: "Leader, 3 support gunners, 2 medics, 2 engineers (ammo crates)", roles: ["leader", "support", "support", "support", "medic", "medic", "engineer", "engineer"], primaryRole: "Suppression and resupply", commands: "Follow; Defend; Suppress; Resupply; Regroup", notes: "Prioritizes friendly force support", status: "Concept" },
    { id: "S004", name: "Anti-Armor Squad", size: 8, organization: "Leader, 4 anti-armor, 1 engineer (AV mines), 1 support, 1 medic", roles: ["leader", "antiarmor", "antiarmor", "antiarmor", "antiarmor", "engineer", "support", "medic"], primaryRole: "Threaten enemy vehicles", commands: "Follow; Attack Vehicle; Ambush; Defend; Regroup", notes: "Prioritizes armor threats and covered firing positions", status: "Concept" },
];

export interface WirModule { id: string; module: string; layer: string; appliesTo: string; responsibilities: string; inputs: string; notes: string; network: string; status: Status | "Built v0.2" | "Deferred" }
export const WIR_MODULES: WirModule[] = [
    { id: "AI001", module: "Strategic WIR", layer: "Strategic", appliesTo: "Team/Battlefield", responsibilities: "Objective selection; front-line assessment; reinforcement allocation; resource priorities", inputs: "Strategic state and team-level observations", notes: "Issue priorities to tactical groups", network: "ar_strategic_brain.wir", status: "Built v0.2" },
    { id: "AI002", module: "Tactical WIR", layer: "Tactical", appliesTo: "Squad/Platoon", responsibilities: "Flanking; suppression; cover selection; regrouping; objective approach; threat prioritization", inputs: "Local observations and strategic orders", notes: "Coordinate squads while allowing local initiative", network: "ar_squad_brain.wir", status: "Built v0.2" },
    { id: "AI003", module: "Infantry WIR", layer: "Specialist", appliesTo: "Individual Soldier", responsibilities: "Movement; aiming; cover use; weapon handling; threat response; squad cohesion", inputs: "Perception, squad state, equipment, orders", notes: "Act independently while respecting squad intent", network: "ar_sense.wir + ar_<role>_brain.wir", status: "Built v0.2" },
    { id: "AI004", module: "Tank WIR", layer: "Vehicle Specialist", appliesTo: "Main Battle Tank/Tank Destroyer", responsibilities: "Navigation; hull and turret orientation; range management; target selection; retreat; crew coordination", inputs: "Vehicle sensors, terrain, armor state, tactical orders", notes: "Use cover and firing positions; distinguish hull movement from turret aim", network: "ar_vsense.wir + ar_tank_brain.wir", status: "Built v0.2" },
    { id: "AI005", module: "APC/IFV WIR", layer: "Vehicle Specialist", appliesTo: "APC/IFV", responsibilities: "Route planning; passenger pickup; safe dismount selection; infantry support; extraction", inputs: "Passenger state, nearby threats, route and objective data", notes: "Prioritize passenger safety and useful deployment positions", network: "ar_vsense.wir + ar_apc_brain.wir", status: "Built v0.2" },
    { id: "AI006", module: "Helicopter WIR", layer: "Aircraft Specialist", appliesTo: "Transport/Attack Helicopter", responsibilities: "Flight; landing-zone assessment; passenger capacity; pickup; threat avoidance; extraction", inputs: "Airspace, terrain, passenger state, threats, mission orders", notes: "Select viable landing zones and avoid predictable approach paths", network: "ar_heli_brain.wir", status: "Built v0.2" },
    { id: "AI007", module: "Fixed-Wing WIR", layer: "Aircraft Specialist", appliesTo: "Fighter/Attack/Transport Aircraft", responsibilities: "Flight path; target approach; payload delivery; airspace deconfliction; return", inputs: "Flight state, target data, payload, threat picture", notes: "Respect payload and runway/landing constraints", network: "ar_jet_brain.wir", status: "Built v0.2" },
    { id: "AI008", module: "Mecha WIR", layer: "Specialist", appliesTo: "Mecha", responsibilities: "Component damage awareness; threat prioritization; weapon selection; movement; defensive positioning", inputs: "Component health, sensors, tactical state, weapon availability", notes: "Adapt tactics as limbs and weapon systems are damaged", network: "ar_vsense.wir + ar_mecha_brain.wir", status: "Built v0.2" },
    { id: "AI009", module: "Logistics WIR", layer: "Support Specialist", appliesTo: "Logistics/Recovery Vehicles", responsibilities: "Supply routing; resupply; repair prioritization; recovery; safe approach", inputs: "Friendly supply demand, damaged assets, route threat", notes: "Keep supply and repair assets behind protected lines where practical", network: "ar_apc_brain.wir (deliver = the neediest friendly asset)", status: "Built v0.2" },
    { id: "AI010", module: "Electronic Warfare WIR", layer: "Support Specialist", appliesTo: "EW Units/Systems", responsibilities: "Sensor disruption; decoy use; emissions management; counter-EW", inputs: "Detected emitters, friendly systems, mission priorities", notes: "Create uncertainty without making detection or targeting arbitrary", network: "(none yet)", status: "Deferred" },
];

// --- loadouts -------------------------------------------------------------------------------

export interface Loadout {
    name: string;
    primary: string;
    /** Attachment ids on the primary, by slot. */
    attachments: Record<string, string>;
    ammo: string;
    sidearm: string;
    launcher: string | null;
    /** Equipment ids (each costs inventory points). */
    equipment: string[];
    /** Armor ids by slot. */
    armor: Partial<Record<ArmorSlot, string>>;
}

export const ROLE_LOADOUTS: Record<Role, Loadout> = {
    leader: { name: "Squad Leader", primary: "W001", attachments: { Optic: "A004", Underbarrel: "A015", Utility: "A017" }, ammo: "AM001", sidearm: "W011", launcher: null, equipment: ["E003", "E004", "E011"], armor: { Helmet: "AR002", Chest: "AR005", Shoulders: "AR007L", Legs: "AR009L" } },
    rifleman: { name: "Rifleman", primary: "W001", attachments: { Optic: "A003", Underbarrel: "A013", Magazine: "A016" }, ammo: "AM001", sidearm: "W011", launcher: null, equipment: ["E003", "E003", "E004"], armor: { Helmet: "AR002", Chest: "AR005", Arms: "AR008L", Legs: "AR009L" } },
    support: { name: "Support Gunner", primary: "W006", attachments: { Optic: "A004", Underbarrel: "A014", Barrel: "A012" }, ammo: "AM005", sidearm: "W011", launcher: null, equipment: ["E008", "E003"], armor: { Helmet: "AR002", Chest: "AR006", Exoskeleton: "AR011" } },
    medic: { name: "Medic", primary: "W002", attachments: { Optic: "A002", Muzzle: "A009" }, ammo: "AM001", sidearm: "W011", launcher: null, equipment: ["E006", "E004", "E004"], armor: { Helmet: "AR002", Chest: "AR005", Legs: "AR009L" } },
    engineer: { name: "Engineer", primary: "W004", attachments: { Optic: "A002", Muzzle: "A007" }, ammo: "AM001", sidearm: "W012", launcher: "W013", equipment: ["E007", "E002", "E009"], armor: { Helmet: "AR002", Chest: "AR005", Exoskeleton: "AR011" } },
    marksman: { name: "Marksman", primary: "W009", attachments: { Optic: "A005", Muzzle: "A007", Underbarrel: "A014" }, ammo: "AM002", sidearm: "W011", launcher: null, equipment: ["E001", "E011"], armor: { Helmet: "AR001", Chest: "AR004", Utility: "AR010", Finish: "AR014" } },
    antiarmor: { name: "Anti-Armor", primary: "W002", attachments: { Optic: "A003" }, ammo: "AM001", sidearm: "W011", launcher: "W014", equipment: ["E002", "E003"], armor: { Helmet: "AR002", Chest: "AR005", Exoskeleton: "AR011" } },
    recon: { name: "Recon", primary: "W008", attachments: { Optic: "A006", Muzzle: "A007", Utility: "A019" }, ammo: "AM001", sidearm: "W012", launcher: null, equipment: ["E011", "E001"], armor: { Helmet: "AR001", Chest: "AR004", Utility: "AR010", Finish: "AR013" } },
};

// --- lookups and derived stats --------------------------------------------------------------

const byId = <T extends { id: string }>(rows: readonly T[]) => new Map(rows.map(r => [r.id, r]));
export const WEAPON = byId(WEAPONS), ATTACHMENT = byId(ATTACHMENTS), ARMOR_BY_ID = byId(ARMOR), AMMO_BY_ID = byId(AMMO), EQUIP = byId(EQUIPMENT), VEHICLE = byId(VEHICLES), MECHA_BY_ID = byId(MECHA), REWARD = byId(REWARDS);

export interface LoadoutStats {
    weight: number; effectiveLoad: number; speedShare: number;
    /** Damage share stopped per hit location (before penetration). */
    head: number; torso: number; arms: number; legs: number; explosive: number;
    visual: number; thermal: number; noise: number;
    inventory: number; inventoryUsed: number;
    /** The primary as fitted: magazine, range, spread when aimed, recoil, zoom, aim time (s), signature of its shots. */
    mag: number; range: number; spread: number; recoil: number; zoom: number; aimTime: number; muzzle: number;
    /** The HMG/AMR can fire well (exoskeleton) or only braced. */
    heavyOk: boolean;
    problems: string[];
}

/** Everything the armory shows and the simulation uses for one loadout. Problems list rule breaks. */
export function loadoutStats(l: Loadout): LoadoutStats {
    const problems: string[] = [];
    const p = WEAPON.get(l.primary);
    if (!p) problems.push(`no weapon ${l.primary}`);
    let weight = (p?.weight ?? 0) + (WEAPON.get(l.sidearm)?.weight ?? 0) + (l.launcher ? WEAPON.get(l.launcher)?.weight ?? 0 : 0);
    let aimTime = 0.3, recoil = p?.recoil ?? 1, spread = p?.aim ?? 1, range = p?.range ?? 100, zoom = 1, muzzle = 1, mag = p?.mag ?? 1;
    for (const [slot, id] of Object.entries(l.attachments)) {
        const a = ATTACHMENT.get(id);
        if (!a) { problems.push(`no attachment ${id}`); continue; }
        if (a.slot !== slot) problems.push(`${a.name} is not a ${slot}`);
        if (p && !a.fits.includes(p.id)) problems.push(`${a.name} does not fit the ${p.name}`);
        if (p && !p.slots.includes(a.slot)) problems.push(`the ${p.name} has no ${a.slot} slot`);
        weight += a.weight; aimTime *= a.aimTime; recoil *= a.recoil; spread *= a.spread; range *= a.range; muzzle *= a.signature; mag = Math.round(mag * a.mag);
        if (a.slot === "Optic") zoom = a.zoom;
    }
    const ammo = AMMO_BY_ID.get(l.ammo);
    if (ammo) { range *= ammo.range; muzzle *= ammo.signature; if (ammo.id === "AM005") spread *= 0.9; }
    let inventory = 4, inventoryUsed = 0, offsets = 0;
    const prot = { head: 0, torso: 0, arms: 0, legs: 0, explosive: 0 };
    let visual = 1, thermal = 1, noise = 1;
    const slots = new Set<string>();
    for (const [slot, id] of Object.entries(l.armor)) {
        const a = ARMOR_BY_ID.get(id);
        if (!a) { problems.push(`no armor ${id}`); continue; }
        if (a.slot !== slot) problems.push(`${a.name} goes in ${a.slot}, not ${slot}`);
        if (slots.has(a.slot)) problems.push(`two ${a.slot} pieces`);
        slots.add(a.slot);
        weight += a.weight; visual *= a.visual; thermal *= a.thermal; noise *= a.noise; offsets += a.offsets;
        if (a.slot === "Chest") inventory = a.inventory;
        if (a.slot === "Helmet") prot.head += a.ballistic;
        if (a.slot === "Chest") prot.torso += a.ballistic;
        if (a.slot === "Shoulders") { prot.torso += a.ballistic * 0.25; prot.arms += a.ballistic * 0.5; }
        if (a.slot === "Arms") prot.arms += a.ballistic;
        if (a.slot === "Legs") prot.legs += a.ballistic;
        if (a.slot === "Exoskeleton" || a.slot === "Finish") { prot.torso += a.ballistic; prot.arms += a.ballistic; prot.legs += a.ballistic; }
        prot.explosive += a.explosive * (a.slot === "Chest" ? 1 : 0.35);
    }
    for (const id of l.equipment) {
        const e = EQUIP.get(id);
        if (!e) { problems.push(`no equipment ${id}`); continue; }
        inventoryUsed += e.cost; weight += e.weight * e.uses;
    }
    if (inventoryUsed > inventory) problems.push(`equipment needs ${inventoryUsed} inventory points, the chest rig holds ${inventory}`);
    const exo = l.armor.Exoskeleton === "AR012";
    if (p?.heavy && !exo) problems.push(`the ${p.name} only fires braced (crouched or prone) without a Heavy Exoskeleton`);
    const effectiveLoad = Math.max(0, weight - offsets);
    const t = Math.min(1, Math.max(0, (effectiveLoad - BALANCE.freeLoad) / (BALANCE.maxLoad - BALANCE.freeLoad)));
    const cap = (v: number) => Math.min(0.8, v);
    return {
        weight: Math.round(weight * 10) / 10, effectiveLoad: Math.round(effectiveLoad * 10) / 10, speedShare: 1 - t * (1 - BALANCE.minSpeedShare),
        head: cap(prot.head), torso: cap(prot.torso), arms: cap(prot.arms), legs: cap(prot.legs), explosive: cap(prot.explosive),
        visual, thermal, noise, inventory, inventoryUsed,
        mag, range, spread, recoil, zoom, aimTime, muzzle, heavyOk: exo, problems: problems.filter(x => !x.includes("only fires braced")),
    };
}

/** Damage a ballistic hit does at distance `d` (m), before armor. */
export function falloff(w: Weapon, d: number, range = w.range): number {
    if (d <= range * 0.25) return w.damage;
    if (d >= range) return w.minDamage * Math.max(0, 1 - (d - range) / range);
    return w.damage + (w.minDamage - w.damage) * ((d - range * 0.25) / (range * 0.75));
}

/** Damage after armor: protection reduced by penetration; hollow points do less against plates. */
export function afterArmor(damage: number, protection: number, ammo: Ammo): number {
    const stopped = protection * (1 - ammo.penetration);
    return damage * ammo.damage * (1 - stopped) * (protection > 0.05 ? ammo.vsArmor : 1);
}

/** Every rule break in the data (the tests keep this empty). */
export function auditData(): string[] {
    const out: string[] = [];
    const ids = [...WEAPONS, ...ATTACHMENTS, ...ARMOR, ...AMMO, ...EQUIPMENT, ...VEHICLES, ...MECHA, ...REWARDS, ...SQUADS, ...WIR_MODULES].map(r => r.id);
    if (new Set(ids).size !== ids.length) out.push("duplicate ids");
    for (const w of WEAPONS) {
        if (w.minDamage > w.damage) out.push(`${w.id} min damage above damage`);
        if (w.rpm <= 0 || w.mag <= 0 || w.range <= 0) out.push(`${w.id} bad numbers`);
    }
    for (const r of Object.entries(ROLE_LOADOUTS)) { const s = loadoutStats(r[1]); if (s.problems.length) out.push(`${r[0]}: ${s.problems.join("; ")}`); }
    for (const sq of SQUADS) if (sq.roles.length !== sq.size || sq.size !== BALANCE.squadSize) out.push(`${sq.id} is not ${BALANCE.squadSize}`);
    if (VEHICLE.get("V015")!.seats !== 16) out.push("the largest helicopter must carry 16");
    if (REWARD.get("R101")!.count !== 16 || REWARD.get("R007")!.count !== 16 || REWARD.get("R007")!.chance !== 0.8) out.push("mine kit / hunter protocol numbers changed");
    return out;
}
