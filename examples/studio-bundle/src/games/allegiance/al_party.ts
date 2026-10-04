// The party: its hierarchy, its money and what it can buy.
//
// Hierarchy. Members join faster than one leader can organize them, so the party needs a chain of
// command beneath you, and members nobody organizes drift away:
//
//   You (the Leader) ── Inner Circle: Treasurer, Propaganda Minister, Spymaster, General
//        │               (no span cost; each boosts one part of the party)
//        ├── Bloc Commissioners (one per power bloc) ── Region Chiefs in that bloc
//        └── Region Chiefs (one per region) ── Cell Leaders ── rank-and-file members
//
// You can direct 4 + Leadership reports (chiefs and commissioners) yourself; a commissioner
// manages 3 + admin/2 chiefs, a chief 3 + admin/2 cell leaders. A region's organizing capacity
// comes from its chief, its cells, you (at headquarters) and, once you govern it, the state.
// Members over capacity are unorganized: they pay little and leave.
//
// Money. Dues from members (organized ones pay in full), taxes from governed regions and
// donations from supporters (more the better your reputation) come in; salaries, the armed
// forces, facilities and governing cost money every day.

import {
    ARMORS, BLOCS, FACILITIES, PAMPHLETS, REGIONS, SCHEMES, SKILL_MAX, WEAPONS, PARTY,
    armorById, regionDefById, skillCost, weaponById, type SkillId,
} from "./al_data";
import {
    type Campaign, type Ledger, type Member, type Role, INNER_CIRCLE, ZERO_LEDGER, addKarma, addTalent, pushNews,
    withRng, totalMembers,
} from "./al_state";

// --- Derived player stats ------------------------------------------------------------------------

export const skill = (c: Campaign, id: SkillId): number => c.party.skills[id] ?? 0;
export const maxHealth = (c: Campaign): number => 100 + 25 * skill(c, "toughness");
export const hasFacility = (c: Campaign, id: string): boolean => c.party.facilities.includes(id);

/** XP needed to go from `level` to the next. */
export const xpForLevel = (level: number): number => 100 * level;

export function gainXp(c: Campaign, amount: number): number {
    c.party.xp += Math.max(0, amount);
    let levels = 0;
    while (c.party.xp >= xpForLevel(c.party.level)) {
        c.party.xp -= xpForLevel(c.party.level);
        c.party.level++;
        c.party.skillPoints++;
        levels++;
    }
    if (levels) pushNews(c, `${c.party.leader} reaches level ${c.party.level}: a new skill point to spend.`, "good");
    return levels;
}

export function raiseSkill(c: Campaign, id: SkillId): string | null {
    const lvl = skill(c, id);
    if (lvl >= SKILL_MAX) return "Already mastered.";
    const cost = skillCost(lvl);
    if (c.party.skillPoints < cost) return `Needs ${cost} skill point${cost > 1 ? "s" : ""}.`;
    c.party.skillPoints -= cost;
    c.party.skills[id] = lvl + 1;
    if (id === "toughness") c.player.health = Math.min(maxHealth(c), c.player.health + 25);
    return null;
}

// --- Hierarchy -----------------------------------------------------------------------------------

export const leaderSpan = (c: Campaign): number => 4 + skill(c, "leadership");
export const officerSpan = (m: Member): number => 3 + Math.floor(m.admin / 2);
export const cellCapacity = (m: Member): number => 150 + 25 * m.admin;
export const chiefCapacity = (m: Member): number => 40 + 10 * m.admin;
export const hqCapacity = (c: Campaign): number => 30 + 10 * skill(c, "leadership");

export const blocOf = (region: string): string => regionDefById(region)?.bloc ?? "";

export interface RegionOrg {
    region: string;
    members: number;
    capacity: number;
    organized: number;
    chief: Member | null;
    chiefManaged: boolean;
    cells: Member[];
    /** Cell leaders beyond what the chief can direct. */
    excessCells: number;
}

export interface OrgReport {
    leaderSpan: number;
    /** Chiefs and commissioners reporting to you directly. */
    directReports: number;
    inner: Record<string, Member | null>;
    commissioners: Member[];
    regions: Record<string, RegionOrg>;
    organized: number;
    total: number;
    /** Plain warnings for the HUD ("Lagos has 3,400 members but no chief"). */
    warnings: string[];
}

export function holder(c: Campaign, role: Role, post: string | null = null): Member | null {
    return c.members.find(m => m.role === role && (post === null || m.post === post)) ?? null;
}

export function orgReport(c: Campaign): OrgReport {
    const inner: Record<string, Member | null> = {};
    for (const r of INNER_CIRCLE) inner[r] = holder(c, r);
    const commissioners = c.members.filter(m => m.role === "commissioner");
    const chiefs = c.members.filter(m => m.role === "chief");
    // Chiefs under a commissioner (up to the commissioner's span) don't report to you.
    const managedByCommissioner = new Set<number>();
    for (const com of commissioners) {
        const under = chiefs.filter(ch => blocOf(ch.post ?? "") === com.post).slice(0, officerSpan(com));
        for (const ch of under) managedByCommissioner.add(ch.id);
    }
    const direct = [...commissioners, ...chiefs.filter(ch => !managedByCommissioner.has(ch.id))];
    const span = leaderSpan(c);
    const managed = new Set<number>([...managedByCommissioner, ...direct.slice(0, span).filter(m => m.role === "chief").map(m => m.id)]);
    const regions: Record<string, RegionOrg> = {};
    let organized = 0, total = 0;
    const warnings: string[] = [];
    for (const def of REGIONS) {
        const rs = c.regions[def.id];
        if (!rs || (rs.members <= 0 && !chiefs.some(ch => ch.post === def.id))) continue;
        const chief = chiefs.find(ch => ch.post === def.id) ?? null;
        const cells = c.members.filter(m => m.role === "cell" && m.post === def.id);
        let capacity = 0;
        if (def.id === c.party.hq) capacity += hqCapacity(c);
        const chiefManaged = !!chief && managed.has(chief.id);
        if (chief) capacity += chiefCapacity(chief) * (chiefManaged ? 1 : 0.5);
        const directed = chief ? officerSpan(chief) : 0;
        cells.forEach((cell, k) => { capacity += cellCapacity(cell) * (k < directed ? 1 : 0.3); });
        if (rs.governor === PARTY) capacity += 5000 + def.pop * 100;
        capacity = Math.round(capacity);
        const org = Math.min(rs.members, capacity);
        organized += org;
        total += rs.members;
        regions[def.id] = { region: def.id, members: rs.members, capacity, organized: org, chief, chiefManaged, cells, excessCells: Math.max(0, cells.length - directed) };
        if (rs.members >= 25 && !chief && def.id !== c.party.hq) warnings.push(`${def.name}: ${fmtInt(rs.members)} members and no Region Chief.`);
        else if (rs.members > capacity * 1.1 && rs.members >= 25) warnings.push(`${def.name}: ${fmtInt(rs.members - capacity)} members unorganized - appoint cell leaders.`);
        if (chief && cells.length > directed) warnings.push(`${def.name}: chief ${chief.name} can only direct ${directed} cells.`);
        if (chief && !chiefManaged) warnings.push(`${def.name}: chief ${chief.name} has no one to report to - appoint a Bloc Commissioner.`);
    }
    if (direct.length > span) warnings.unshift(`You can direct ${span} officers; ${direct.length} report to you. Appoint commissioners or raise Leadership.`);
    for (const r of INNER_CIRCLE) if (!inner[r] && totalMembers(c) > 40) warnings.push(`No ${ROLE_NAMES[r]} in the Inner Circle.`);
    return { leaderSpan: span, directReports: direct.length, inner, commissioners, regions, organized, total, warnings };
}

export const ROLE_NAMES: Record<Role, string> = {
    none: "Member", treasurer: "Treasurer", propaganda: "Propaganda Minister", spymaster: "Spymaster", general: "General",
    commissioner: "Bloc Commissioner", chief: "Region Chief", cell: "Cell Leader",
};

export const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Puts a member in a post; returns an error message or null. `post` is a region (chief, cell) or a bloc (commissioner). */
export function appoint(c: Campaign, memberId: number, role: Role, post: string | null = null): string | null {
    const m = c.members.find(x => x.id === memberId);
    if (!m) return "No such member.";
    if (role === "none") { m.role = "none"; m.post = null; return null; }
    if (INNER_CIRCLE.includes(role)) {
        const prev = holder(c, role);
        if (prev && prev.id !== m.id) { prev.role = "none"; prev.post = null; }
        m.role = role; m.post = null;
        return null;
    }
    if (role === "commissioner") {
        if (!post || !BLOCS.some(b => b.id === post)) return "Pick a bloc for the commissioner.";
        const prev = holder(c, "commissioner", post);
        if (prev && prev.id !== m.id) { prev.role = "none"; prev.post = null; }
    } else {
        if (!post || !c.regions[post]) return "Pick a region.";
        if (role === "chief") {
            const prev = holder(c, "chief", post);
            if (prev && prev.id !== m.id) { prev.role = "none"; prev.post = null; }
        } else if (role === "cell" && !holder(c, "chief", post) && post !== c.party.hq) {
            return "A region needs a Region Chief before it can have cells.";
        }
    }
    m.role = role; m.post = post;
    m.follower = false;
    return null;
}

/** Fills empty posts with the best available members: what a good chief of staff would do. */
export function autoOrganize(c: Campaign): string[] {
    const done: string[] = [];
    const free = () => c.members.filter(m => m.role === "none" && !m.follower);
    const best = (score: (m: Member) => number, prefer?: (m: Member) => boolean) => {
        const pool = free();
        const preferred = prefer ? pool.filter(prefer) : [];
        const list = preferred.length ? preferred : pool;
        return list.sort((a, b) => score(b) - score(a))[0] ?? null;
    };
    const innerScore: Record<string, (m: Member) => number> = {
        treasurer: m => m.admin * 2 + m.loyalty / 20, propaganda: m => m.charisma * 2 + m.admin / 2,
        spymaster: m => m.admin + m.combat + m.loyalty / 15, general: m => m.combat * 2 + m.admin / 2,
    };
    for (const r of INNER_CIRCLE) {
        if (holder(c, r)) continue;
        const m = best(innerScore[r]);
        if (m) { appoint(c, m.id, r); done.push(`${m.name} → ${ROLE_NAMES[r]}`); }
    }
    // Chiefs where there are members, biggest regions first.
    const regions = Object.values(c.regions).filter(r => r.members >= 20 && r.id !== c.party.hq || (r.id === c.party.hq && r.members > hqCapacity(c)))
        .sort((a, b) => b.members - a.members);
    for (const rs of regions) {
        if (holder(c, "chief", rs.id)) continue;
        const m = best(m => m.admin * 2 + m.charisma, m => m.region === rs.id);
        if (!m) break;
        appoint(c, m.id, "chief", rs.id);
        done.push(`${m.name} → Chief of ${regionDefById(rs.id)?.name}`);
    }
    // Commissioners for blocs with more than one chief, once you can't direct them all.
    let report = orgReport(c);
    if (report.directReports > report.leaderSpan) {
        const counts = new Map<string, number>();
        for (const ch of c.members.filter(m => m.role === "chief")) counts.set(blocOf(ch.post ?? ""), (counts.get(blocOf(ch.post ?? "")) ?? 0) + 1);
        for (const [bloc, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
            if (n < 2 || holder(c, "commissioner", bloc)) continue;
            const m = best(m => m.admin * 2 + m.loyalty / 10);
            if (!m) break;
            appoint(c, m.id, "commissioner", bloc);
            done.push(`${m.name} → Commissioner of ${BLOCS.find(b => b.id === bloc)?.short}`);
            report = orgReport(c);
            if (report.directReports <= report.leaderSpan) break;
        }
    }
    // Cell leaders where members outnumber capacity.
    report = orgReport(c);
    for (const ro of Object.values(report.regions).sort((a, b) => (b.members - b.capacity) - (a.members - a.capacity))) {
        let gap = ro.members - ro.capacity;
        let slots = ro.chief ? officerSpan(ro.chief) - ro.cells.length : (ro.region === c.party.hq ? 2 - ro.cells.length : 0);
        while (gap > 0 && slots > 0) {
            const m = best(m => m.admin + m.charisma, m => m.region === ro.region);
            if (!m) break;
            appoint(c, m.id, "cell", ro.region);
            done.push(`${m.name} → Cell Leader in ${regionDefById(ro.region)?.name}`);
            gap -= cellCapacity(m);
            slots--;
        }
    }
    return done;
}

// --- Armed forces --------------------------------------------------------------------------------

/** Cost to arm and train one rank-and-file member. */
export const ARM_COST = 120;
/** Daily upkeep per armed member. */
export const ARMY_UPKEEP = 0.8;

export function armMembers(c: Campaign, region: string, count: number): string | null {
    const rs = c.regions[region];
    if (!rs) return "No such region.";
    const n = Math.floor(Math.min(count, rs.members - 1));
    if (n <= 0) return "No members here to arm.";
    const cost = n * ARM_COST;
    if (c.party.funds < cost) return `Arming ${fmtInt(n)} costs CR ${fmtInt(cost)}.`;
    c.party.funds -= cost;
    rs.members -= n;
    rs.army += n;
    rs.heat = Math.min(1, rs.heat + 0.05 + n / 20000);
    return null;
}

export function disarm(c: Campaign, region: string, count: number): void {
    const rs = c.regions[region];
    if (!rs) return;
    const n = Math.floor(Math.min(count, rs.army));
    rs.army -= n;
    rs.members += n;
}

/** Moves armed members between regions (a march: a day's travel, no cost beyond upkeep). */
export function moveArmy(c: Campaign, from: string, to: string, count: number): string | null {
    const a = c.regions[from], b = c.regions[to];
    if (!a || !b) return "No such region.";
    const n = Math.floor(Math.min(count, a.army));
    if (n <= 0) return "No troops to move.";
    a.army -= n;
    b.army += n;
    if (a.war) a.war.partyStrength = Math.max(0, a.war.partyStrength - n);
    if (b.war) b.war.partyStrength += n;
    return null;
}

/** How well the party's troops fight (0..~1.6). */
export function partyQuality(c: Campaign, region: string, playerPresent: boolean): number {
    let q = 0.5;
    if (hasFacility(c, "camp")) q += 0.3;
    const gen = holder(c, "general");
    if (gen) q += gen.combat * 0.025;
    q += skill(c, "leadership") * 0.03;
    const field = c.party.posture === "field" ? 1 : c.party.posture === "mixed" ? 0.5 : 0;
    if (playerPresent) q *= 1 + 0.25 * Math.max(0.4, field);
    return q;
}

// --- Shop ----------------------------------------------------------------------------------------

function spend(c: Campaign, amount: number): string | null {
    if (c.party.funds < amount) return `Not enough funds (CR ${fmtInt(amount)} needed).`;
    c.party.funds -= amount;
    return null;
}

export function buyWeapon(c: Campaign, id: string): string | null {
    const w = WEAPONS.find(x => x.id === id);
    if (!w) return "No such weapon.";
    if (c.player.weapons.includes(id)) return "You already own it.";
    const err = spend(c, w.price);
    if (err) return err;
    c.player.weapons.push(id);
    c.player.ammo[id] = (c.player.ammo[id] ?? 0) + (Number.isFinite(w.magazine) ? w.magazine * 3 : 0);
    c.player.weapon = id;
    return null;
}

export const ammoPrice = (id: string): number => Math.max(5, Math.round(weaponById(id).price / 40));

export function buyAmmo(c: Campaign, id: string): string | null {
    const w = weaponById(id);
    if (!Number.isFinite(w.magazine)) return "No ammunition needed.";
    const err = spend(c, ammoPrice(id));
    if (err) return err;
    c.player.ammo[id] = (c.player.ammo[id] ?? 0) + w.magazine;
    return null;
}

export function buyArmor(c: Campaign, id: string): string | null {
    const a = ARMORS.find(x => x.id === id);
    if (!a) return "No such armor.";
    if (c.player.armorId === id && c.player.armor >= a.armor) return "Already wearing it, fully repaired.";
    const price = c.player.armorId === id ? Math.round(a.price * 0.25) : a.price;
    const err = spend(c, price);
    if (err) return err;
    c.player.armorId = id;
    c.player.armor = a.armor;
    return null;
}

export const pamphletPrice = (c: Campaign, id: string): number => {
    const p = PAMPHLETS.find(x => x.id === id);
    return Math.round((p?.price ?? 5) * (hasFacility(c, "press") ? 0.5 : 1) * 10);
};

/** Buys a bundle of 10 pamphlets. */
export function buyPamphlets(c: Campaign, id: string): string | null {
    if (!PAMPHLETS.some(p => p.id === id)) return "No such pamphlet.";
    const err = spend(c, pamphletPrice(c, id));
    if (err) return err;
    c.player.pamphlets[id] = (c.player.pamphlets[id] ?? 0) + 10;
    return null;
}

export function buyFacility(c: Campaign, id: string): string | null {
    const f = FACILITIES.find(x => x.id === id);
    if (!f) return "No such facility.";
    if (hasFacility(c, id)) return "Already built.";
    const err = spend(c, f.price);
    if (err) return err;
    c.party.facilities.push(id);
    pushNews(c, `The party opens a ${f.name}.`, "good");
    return null;
}

// --- Schemes -------------------------------------------------------------------------------------

export function schemeChance(c: Campaign, schemeId: string, region: string): number {
    const s = SCHEMES.find(x => x.id === schemeId);
    if (!s) return 0;
    const spy = holder(c, "spymaster");
    const rs = c.regions[region];
    const inside = c.party.posture === "inside" ? 0.1 : c.party.posture === "mixed" ? 0.05 : 0;
    return Math.max(0.05, Math.min(0.97, s.chance + skill(c, "intrigue") * 0.04 + (spy ? spy.admin * 0.012 : 0) + inside - (rs?.heat ?? 0) * 0.2));
}

export const schemeCost = (c: Campaign, schemeId: string): number =>
    Math.round((SCHEMES.find(x => x.id === schemeId)?.cost ?? 0) * (1 - skill(c, "intrigue") * 0.06));

export function startScheme(c: Campaign, schemeId: string, region: string): string | null {
    const s = SCHEMES.find(x => x.id === schemeId);
    if (!s) return "No such scheme.";
    const rs = c.regions[region];
    if (!rs) return "No such region.";
    if (rs.members <= 0 && region !== c.party.hq) return "The party has no members there to carry it out.";
    if (c.schemes.some(x => x.scheme === schemeId && x.region === region)) return "That scheme is already underway there.";
    const err = spend(c, schemeCost(c, schemeId));
    if (err) return err;
    c.schemes.push({ id: c.nextSchemeId++, scheme: schemeId, region, daysLeft: s.days, chance: schemeChance(c, schemeId, region) });
    return null;
}

// --- Daily: loyalty and money --------------------------------------------------------------------

/** Named members' loyalty, defections, and the unorganized masses drifting away. */
export function dailyMembers(c: Campaign): void {
    const report = orgReport(c);
    withRng(c, r => {
        for (const m of [...c.members]) {
            const officer = m.role !== "none";
            const ro = report.regions[m.region];
            const organized = officer || m.follower || (ro ? ro.organized >= ro.members : true);
            let drift = officer ? 0.4 : organized ? 0.2 : -0.8;
            // Brutality wins obedience from some and disgust from others.
            if (c.party.karma < -40) drift += (m.combat > m.charisma ? 0.2 : -0.5);
            if (c.party.karma > 40) drift += 0.2;
            if (c.party.funds < 0) drift -= 1;
            m.loyalty = Math.max(0, Math.min(100, m.loyalty + drift));
            if (m.loyalty < 15 && r.next() < 0.25) {
                c.members.splice(c.members.indexOf(m), 1);
                const rs = c.regions[m.region];
                if (rs) { rs.heat = Math.min(1, rs.heat + 0.12); rs.members = Math.max(0, rs.members - 1); }
                pushNews(c, `${m.name} defects and talks to the authorities.`, "bad");
            }
        }
        // Unorganized rank-and-file leave.
        for (const ro of Object.values(report.regions)) {
            const loose = ro.members - ro.organized;
            if (loose > 0) c.regions[ro.region].members = Math.max(0, ro.members - Math.ceil(loose * 0.02));
        }
        // New talent rises from a growing party (more members, more capable people to promote).
        const total = totalMembers(c);
        const expected = Math.min(3, Math.sqrt(total) / 40);
        const named = c.members.length;
        if (named < 400 && r.next() < expected) {
            const regions = Object.values(c.regions).filter(x => x.members > 0);
            const w = regions.map(x => x.members);
            let pickAt = r.next() * w.reduce((a, b) => a + b, 0);
            let region = regions[0]?.id ?? c.party.hq;
            for (let i = 0; i < regions.length; i++) { pickAt -= w[i]; if (pickAt <= 0) { region = regions[i].id; break; } }
            addTalent(c, region, r);
        }
    });
}

export function dailyLedger(c: Campaign): Ledger {
    const report = orgReport(c);
    const l: Ledger = { ...ZERO_LEDGER };
    const treasurer = holder(c, "treasurer");
    const bank = hasFacility(c, "bank") ? 1.15 : 1;
    const inside = c.party.posture === "inside" ? 1.1 : c.party.posture === "mixed" ? 1.05 : 1;
    const collect = bank * inside * (1 + (treasurer ? treasurer.admin / 20 : 0));
    for (const def of REGIONS) {
        const rs = c.regions[def.id];
        const ro = report.regions[def.id];
        const organized = ro ? ro.organized : 0;
        l.dues += (organized + (rs.members - organized) * 0.15) * c.party.duesRate * def.wealth * collect;
        if (rs.governor === PARTY) {
            l.taxes += def.pop * 1e6 * def.wealth * rs.taxRate * 0.00012 * collect;
            l.admin += def.pop * 6;
        }
        if (c.party.karma > 0) l.donations += rs.support[PARTY] * def.pop * def.wealth * 4 * (c.party.karma / 100);
        l.army += rs.army * ARMY_UPKEEP;
    }
    l.salaries = c.members.filter(m => m.role !== "none").length * 20;
    l.facilities = c.party.facilities.reduce((s, id) => s + (FACILITIES.find(f => f.id === id)?.upkeep ?? 0), 0);
    for (const k of Object.keys(l) as (keyof Ledger)[]) l[k] = Math.round(l[k]);
    l.net = l.dues + l.taxes + l.donations + l.schemes - l.salaries - l.army - l.facilities - l.admin;
    return l;
}

export function applyLedger(c: Campaign, l: Ledger): void {
    c.party.funds += l.net;
    c.ledger = l;
    if (c.party.funds < 0) c.party.brokeDays++;
    else c.party.brokeDays = 0;
    if (c.party.brokeDays === 3) pushNews(c, "The party treasury is empty. Members are going unpaid.", "bad");
}

/** A member met on the street joins: a named member, counted in the region's rank-and-file too. */
export function recruitInPerson(c: Campaign, region: string, who: { name: string; charisma: number; admin: number; combat: number }, follower = false): Member {
    const m: Member = {
        id: c.nextMemberId++, name: who.name, region,
        charisma: who.charisma, admin: who.admin, combat: who.combat, loyalty: 70,
        role: "none", post: null, follower, armed: false, inPerson: true, joinedDay: c.day,
    };
    c.members.push(m);
    const rs = c.regions[region];
    if (rs) rs.members += 1;
    c.stats.recruits++;
    c.party.peakMembers = Math.max(c.party.peakMembers, totalMembers(c));
    gainXp(c, 15);
    return m;
}

export const followers = (c: Campaign): Member[] => c.members.filter(m => m.follower);
export const followerLimit = (c: Campaign): number => 2 + skill(c, "leadership");

export function setFollower(c: Campaign, memberId: number, on: boolean): string | null {
    const m = c.members.find(x => x.id === memberId);
    if (!m) return "No such member.";
    if (on && !m.follower && followers(c).length >= followerLimit(c)) return `You can lead ${followerLimit(c)} followers on the street (Leadership raises it).`;
    if (on && m.role !== "none") { m.role = "none"; m.post = null; }
    m.follower = on;
    if (on && !m.armed && c.party.funds >= ARM_COST) { m.armed = true; c.party.funds -= ARM_COST; }
    return null;
}

/** Karma for actions taken on the street (the addon calls this). */
export function streetKarma(c: Campaign, amount: number): void {
    addKarma(c, amount);
}

export { armorById, weaponById, PARTY };
