// Inventory, shops and loot: what you carry besides weapons and pamphlets, the shops you walk
// into on the street, and the supplies left in houses you can enter. Plain functions over the
// campaign, like al_party.ts, so the tests drive them without a window.

import { ARMORS, PAMPHLETS, WEAPONS, weaponById } from "./al_data";
import { type Campaign } from "./al_state";
import { ammoPrice, buyAmmo, buyArmor, buyPamphlets, buyWeapon, maxHealth, pamphletPrice } from "./al_party";
import { CAR_UPGRADES, carUpgradeById, type CarUpgradeId } from "./al_vehicle";
import { hashString } from "./al_rng";

// --- Items ---------------------------------------------------------------------------------------

export type ItemId = "medkit" | "stim" | "ration" | "armor-patch" | "ammo-box" | "scrap";

export interface ItemDef {
    id: ItemId;
    name: string;
    price: number;
    /** What a shop pays for one (0: not bought back). */
    sell: number;
    blurb: string;
    /** Usable from the inventory (scrap is only sold). */
    usable: boolean;
}

export const ITEMS: ItemDef[] = [
    { id: "medkit", name: "Field Medkit", price: 120, sell: 40, blurb: "Restores 60 health.", usable: true },
    { id: "stim", name: "Combat Stim", price: 70, sell: 20, blurb: "Restores 25 health and all stamina.", usable: true },
    { id: "ration", name: "Ration Pack", price: 20, sell: 6, blurb: "Restores 15 health.", usable: true },
    { id: "armor-patch", name: "Armor Patch", price: 150, sell: 50, blurb: "Repairs 40 points of worn armor.", usable: true },
    { id: "ammo-box", name: "Ammo Box", price: 90, sell: 30, blurb: "A magazine for every gun you carry.", usable: true },
    { id: "scrap", name: "Scrap Electronics", price: 0, sell: 60, blurb: "Salvage. Shops and garages buy it.", usable: false },
];

export const itemById = (id: string): ItemDef | undefined => ITEMS.find(i => i.id === id);

export function inventory(c: Campaign): Record<string, number> {
    return (c.player.inventory ??= {});
}

export function itemCount(c: Campaign, id: string): number {
    return inventory(c)[id] ?? 0;
}

export function addItem(c: Campaign, id: string, count = 1): void {
    const inv = inventory(c);
    inv[id] = Math.max(0, (inv[id] ?? 0) + count);
    if (inv[id] === 0) delete inv[id];
}

/** What using an item needs from the street (health and stamina live there while you play). */
export interface UseTarget {
    health: number;
    armor: number;
    stamina: number;
}

/**
 * Uses one `id` from the inventory on `t` (the addon passes the street player and body, then
 * reads them back). Returns a message, or an error starting with "!".
 */
export function useItem(c: Campaign, id: string, t: UseTarget): string {
    const def = itemById(id);
    if (!def || !def.usable) return "!That can't be used.";
    if (itemCount(c, id) <= 0) return `!No ${def.name} left.`;
    const top = maxHealth(c);
    const heal = (n: number) => { t.health = Math.min(top, t.health + n); };
    switch (def.id) {
        case "medkit": case "ration": {
            if (t.health >= top) return "!You are already at full health.";
            heal(def.id === "medkit" ? 60 : 15);
            break;
        }
        case "stim": heal(25); t.stamina = 1; break;
        case "armor-patch": {
            const full = ARMORS.find(a => a.id === c.player.armorId)?.armor ?? 0;
            if (!full) return "!Wear armor first (gunsmiths sell it).";
            if (t.armor >= full) return "!Your armor is intact.";
            t.armor = Math.min(full, t.armor + 40);
            break;
        }
        case "ammo-box": {
            const guns = c.player.weapons.filter(w => Number.isFinite(weaponById(w).magazine));
            if (!guns.length) return "!You carry no guns.";
            for (const w of guns) c.player.ammo[w] = (c.player.ammo[w] ?? 0) + weaponById(w).magazine;
            break;
        }
        default: return "!That can't be used.";
    }
    addItem(c, id, -1);
    return `Used ${def.name}.`;
}

/** The best healing item to use right now (the quick-heal key), or null. */
export function quickHealItem(c: Campaign, health: number): ItemId | null {
    const missing = maxHealth(c) - health;
    if (missing <= 0) return null;
    const order: ItemId[] = missing > 40 ? ["medkit", "stim", "ration"] : ["ration", "stim", "medkit"];
    return order.find(id => itemCount(c, id) > 0) ?? null;
}

// --- Shops ---------------------------------------------------------------------------------------

export type ShopKind = "general" | "gunsmith" | "garage";

export const SHOP_NAMES: Record<ShopKind, string> = { general: "General Store", gunsmith: "Gunsmith", garage: "Hover Garage" };

/** Roughly one non-residential building in this many is a shop you can walk into. */
export const SHOP_EVERY = 7;

/**
 * The shop in a building, if it has one. Houses are homes, never shops. Deterministic in the
 * building's key, so a shop is always where you found it.
 */
export function shopForBuilding(key: string, kind: string): ShopKind | null {
    if (kind === "house") return null;
    const h = hashString(`shop:${key}`);
    if (h % SHOP_EVERY !== 0) return null;
    return (["general", "gunsmith", "garage"] as ShopKind[])[(h >>> 8) % 3];
}

/** One line of a shop's stock: what it is, its price, and whether you can buy it now. */
export interface StockLine {
    id: string;
    kind: "item" | "weapon" | "ammo" | "armor" | "pamphlets" | "car";
    name: string;
    price: number;
    blurb: string;
    /** Why it can't be bought ("owned", "max"), or null. */
    blocked: string | null;
}

export function shopStock(c: Campaign, kind: ShopKind | "hq"): StockLine[] {
    const out: StockLine[] = [];
    const general = kind === "general" || kind === "hq", guns = kind === "gunsmith" || kind === "hq", garage = kind === "garage" || kind === "hq";
    if (general) {
        for (const it of ITEMS) if (it.price > 0) out.push({ id: it.id, kind: "item", name: it.name, price: it.price, blurb: it.blurb, blocked: null });
        for (const p of PAMPHLETS) out.push({ id: p.id, kind: "pamphlets", name: `${p.name} x10`, price: pamphletPrice(c, p.id), blurb: p.blurb, blocked: null });
    }
    if (guns) {
        for (const w of WEAPONS) if (w.price > 0) out.push({ id: w.id, kind: "weapon", name: w.name, price: w.price, blurb: w.blurb, blocked: c.player.weapons.includes(w.id) ? "OWNED" : null });
        for (const w of c.player.weapons) {
            const def = weaponById(w);
            if (Number.isFinite(def.magazine)) out.push({ id: w, kind: "ammo", name: `${def.name} rounds`, price: ammoPrice(w), blurb: `${def.magazine} rounds.`, blocked: null });
        }
        for (const a of ARMORS) if (a.price > 0) {
            const worn = c.player.armorId === a.id;
            out.push({ id: a.id, kind: "armor", name: worn ? `Repair ${a.name}` : a.name, price: worn ? Math.round(a.price * 0.25) : a.price, blurb: a.blurb, blocked: worn && c.player.armor >= a.armor ? "WORN" : null });
        }
    }
    if (garage) {
        for (const u of CAR_UPGRADES) {
            const tier = carTier(c, u.id);
            out.push({ id: u.id, kind: "car", name: `${u.name} ${["I", "II", "III"][Math.min(2, tier)]}`, price: tier >= 3 ? 0 : u.prices[tier], blurb: u.blurb, blocked: tier >= 3 ? "MAX" : null });
        }
    }
    return out;
}

export const carTier = (c: Campaign, id: CarUpgradeId): number => c.player.carUpgrades?.[id] ?? 0;

export function buyCarUpgrade(c: Campaign, id: string): string | null {
    const def = carUpgradeById(id);
    if (!def) return "No such upgrade.";
    const tier = carTier(c, def.id);
    if (tier >= 3) return `${def.name} are fully upgraded.`;
    const price = def.prices[tier];
    if (c.party.funds < price) return `That costs CR ${price.toLocaleString("en-US")}.`;
    c.party.funds -= price;
    (c.player.carUpgrades ??= {})[def.id] = tier + 1;
    return null;
}

export function buyItem(c: Campaign, id: string, count = 1): string | null {
    const def = itemById(id);
    if (!def || def.price <= 0) return "Not for sale.";
    const price = def.price * count;
    if (c.party.funds < price) return `That costs CR ${price.toLocaleString("en-US")}.`;
    c.party.funds -= price;
    addItem(c, id, count);
    return null;
}

/** Sells one `id`; returns the credits, or an error. */
export function sellItem(c: Campaign, id: string): number | string {
    const def = itemById(id);
    if (!def || def.sell <= 0) return "Nobody buys that.";
    if (itemCount(c, id) <= 0) return `No ${def.name} to sell.`;
    addItem(c, id, -1);
    c.party.funds += def.sell;
    return def.sell;
}

/** Buys one stock line through the right rule (al_party for gear, here for items and the car). */
export function buyStock(c: Campaign, line: Pick<StockLine, "id" | "kind">): string | null {
    switch (line.kind) {
        case "item": return buyItem(c, line.id);
        case "weapon": return buyWeapon(c, line.id);
        case "ammo": return buyAmmo(c, line.id);
        case "armor": return buyArmor(c, line.id);
        case "pamphlets": return buyPamphlets(c, line.id);
        case "car": return buyCarUpgrade(c, line.id);
    }
}

// --- Loot ----------------------------------------------------------------------------------------

export interface LootItem { id: ItemId | "credits" | "pamphlets"; count: number }

/** A cache of supplies inside a house: where it sits (in the house's own u/v, from its center, as
 * shares of the half-extents) and what is in it. */
export interface LootCache { key: string; u: number; v: number; items: LootItem[] }

/** The supplies left in a house (deterministic in its key). Some houses hold nothing. */
export function houseLoot(houseKey: string): LootCache | null {
    let h = hashString(`loot:${houseKey}`);
    const next = () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = (h ^ (h >>> 12)) >>> 0; return h / 4294967296; };
    if (next() < 0.2) return null;
    const table: [LootItem["id"], number, number][] = [
        ["credits", 30, 220], ["medkit", 1, 1], ["ration", 1, 3], ["ammo-box", 1, 1], ["pamphlets", 10, 20], ["scrap", 1, 3], ["stim", 1, 1], ["armor-patch", 1, 1],
    ];
    const weights = [4, 2, 3, 2, 2, 3, 1, 1];
    const total = weights.reduce((a, b) => a + b, 0);
    const n = 1 + Math.floor(next() * 3);
    const items: LootItem[] = [];
    for (let k = 0; k < n; k++) {
        let pick = next() * total, i = 0;
        while (pick > weights[i]) { pick -= weights[i]; i++; }
        const [id, lo, hi] = table[i];
        const count = lo + Math.floor(next() * (hi - lo + 1));
        const same = items.find(x => x.id === id);
        if (same) same.count += count; else items.push({ id, count });
    }
    return { key: houseKey, u: (next() - 0.5) * 1.2, v: (next() - 0.5) * 1.2, items };
}

export const isLooted = (c: Campaign, houseKey: string): boolean => (c.looted ?? []).includes(houseKey);

/** Takes a house's supplies into the inventory (once per house). Returns what was taken, as text. */
export function takeHouseLoot(c: Campaign, cache: LootCache): string | null {
    if (isLooted(c, cache.key)) return null;
    const looted = (c.looted ??= []);
    looted.push(cache.key);
    if (looted.length > 4000) looted.splice(0, looted.length - 4000);
    const parts: string[] = [];
    for (const it of cache.items) {
        if (it.id === "credits") { c.party.funds += it.count; parts.push(`CR ${it.count}`); }
        else if (it.id === "pamphlets") { c.player.pamphlets.propaganda = (c.player.pamphlets.propaganda ?? 0) + it.count; parts.push(`${it.count} pamphlets`); }
        else { addItem(c, it.id, it.count); parts.push(`${it.count} x ${itemById(it.id)!.name}`); }
    }
    return parts.join(", ");
}
