// The speech: Allegiance's signature mini-game, as a pure state machine the addon draws and feeds
// keys to (and the tests drive directly).
//
// A speech is five beats. Each beat:
//   1. CHOOSE - three cards from your deck (topic + tone: hope, anger or fear). The crowd is made
//      of segments (workers, students, professionals, elders, the faithful, veterans) in the mix
//      this region has; each cares about different topics and takes each tone differently. Your
//      ideology makes you stronger on some topics and weaker on others. Repeating a topic bores.
//   2. DELIVER - a marker sweeps a bar; hit SPACE inside the sweet zone. Perfect, good, weak or
//      miss multiplies the card. Perfect lines build a combo and fervor, which amplify everything.
//   3. Sometimes a HECKLER interrupts: press the key they flash before the window closes to
//      rebut them (the crowd loves it) or lose face.
// A rival orator may be working the same square. Their next topic is announced; answer it with
// the same topic to rebut them (your line hits harder, theirs lands softer). At the end the crowd
// leans to whoever moved them more.
//
// The result says how good the speech was, how many listeners join the party, each segment's
// approval (the addon nudges the actual listeners' opinions by it) and the karma it cost or won.

import {
    SEGMENTS, SPEECH_CARDS, blocById, factionById, ideologyById, regionDefById, type SpeechCard, type Tone, type TopicId,
    type TopicWeights,
} from "./al_data";
import { type Rng, makeRng, pick, clamp } from "./al_rng";

export const BEATS = 5;
export const CHOOSE_SECONDS = 9;
export const DELIVER_SECONDS = 4.5;
export const HECKLE_KEYS = ["q", "e", "r", "f"];

export type Grade = "perfect" | "good" | "weak" | "miss";
export const GRADE_VALUE: Record<Grade, number> = { perfect: 1, good: 0.75, weak: 0.45, miss: 0.12 };

export interface SegmentState { id: string; name: string; share: number; approval: number; rival: number }

export interface RivalOrator { faction: string; name: string; skill: number; topic: TopicId; total: number }

export interface SpeechState {
    phase: "choose" | "deliver" | "heckle" | "react" | "done";
    beat: number;
    phaseTime: number;
    hand: SpeechCard[];
    chosen: SpeechCard | null;
    /** Delivery bar: marker position 0..1, the sweet zone's center and half-width. */
    marker: number;
    markerDir: 1 | -1;
    markerSpeed: number;
    sweet: number;
    sweetHalf: number;
    lastGrade: Grade | null;
    grades: Grade[];
    segments: SegmentState[];
    crowd: number;
    fervor: number;
    combo: number;
    heckler: { key: string; line: string; window: number } | null;
    rival: RivalOrator | null;
    usedTopics: TopicId[];
    karma: number;
    /** Lines for the speech HUD, newest first. */
    log: string[];
    rngState: number;
    regionTopics: TopicWeights;
    ideology: string;
    oratory: number;
    persuasion: number;
    heat: number;
    result: SpeechResult | null;
}

export interface SpeechResult {
    score: number;
    crowd: number;
    joined: number;
    karma: number;
    approval: Record<string, number>;
    grades: Grade[];
    rival: null | { faction: string; won: boolean; margin: number };
}

export interface SpeechOptions {
    region: string;
    ideology: string;
    oratory: number;
    persuasion: number;
    /** People listening when you start. */
    crowd: number;
    seed: number;
    heat?: number;
    rival?: { faction: string; name: string; skill: number } | null;
    /** Segment shares for the listeners actually in front of you (defaults to the region's mix). */
    segmentShares?: Record<string, number>;
}

/** The audience mix of a region: poorer regions are more workers, richer more professionals. */
export function regionSegments(regionId: string): Record<string, number> {
    const def = regionDefById(regionId);
    const bloc = blocById(def?.bloc ?? "nac");
    const w = def?.wealth ?? 1;
    const raw: Record<string, number> = {
        workers: 0.3 + 0.25 * Math.max(0, 1.2 - w),
        students: 0.15 + 0.05 * bloc.topics.liberty,
        professionals: 0.08 + 0.18 * Math.min(1.8, w),
        elders: 0.12 + 0.06 * bloc.topics.security,
        faithful: 0.06 + 0.16 * bloc.topics.tradition,
        veterans: 0.05 + 0.08 * bloc.topics.security,
    };
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(raw)) raw[k] /= total;
    return raw;
}

export function deckFor(oratory: number): SpeechCard[] {
    return SPEECH_CARDS.filter(c => c.oratory <= oratory);
}

function rng(s: SpeechState): Rng { return makeRng(s.rngState); }

function drawHand(s: SpeechState, r: Rng): void {
    const deck = deckFor(s.oratory);
    const hand: SpeechCard[] = [];
    // Offer the rival's topic when there is one, so a rebuttal is possible.
    if (s.rival) {
        const answer = deck.filter(c => c.topic === s.rival!.topic);
        if (answer.length) hand.push(pick(r, answer));
    }
    let guard = 0;
    while (hand.length < 3 && guard++ < 100) {
        const c = pick(r, deck);
        if (hand.some(h => h.id === c.id || h.topic === c.topic)) continue;
        hand.push(c);
    }
    s.hand = hand;
}

function newSweet(s: SpeechState, r: Rng): void {
    s.sweetHalf = 0.07 + 0.015 * s.oratory;
    s.sweet = 0.25 + r.next() * 0.5;
    s.marker = 0;
    s.markerDir = 1;
    s.markerSpeed = 0.75 + s.beat * 0.12;
}

export function startSpeech(o: SpeechOptions): SpeechState {
    const def = regionDefById(o.region);
    const shares = o.segmentShares ?? regionSegments(o.region);
    const r = makeRng(o.seed);
    const s: SpeechState = {
        phase: "choose", beat: 0, phaseTime: 0, hand: [], chosen: null,
        marker: 0, markerDir: 1, markerSpeed: 0.8, sweet: 0.5, sweetHalf: 0.1,
        lastGrade: null, grades: [],
        segments: SEGMENTS.map(seg => ({ id: seg.id, name: seg.name, share: shares[seg.id] ?? 0, approval: 0, rival: 0 })).filter(x => x.share > 0),
        crowd: Math.max(3, Math.round(o.crowd)),
        fervor: 0.2, combo: 0, heckler: null,
        rival: o.rival ? { ...o.rival, topic: pick(r, factionById(o.rival.faction).topics.length ? factionById(o.rival.faction).topics : ["security" as TopicId]), total: 0 } : null,
        usedTopics: [], karma: 0, log: [],
        rngState: 0,
        regionTopics: blocById(def?.bloc ?? "nac").topics,
        ideology: o.ideology, oratory: o.oratory, persuasion: o.persuasion, heat: o.heat ?? 0,
        result: null,
    };
    drawHand(s, r);
    s.rngState = r.state();
    s.log.unshift(s.rival ? `${s.rival.name} of ${factionById(s.rival.faction).name} is speaking across the square!` : `A crowd of ${s.crowd} gathers. Win them over.`);
    return s;
}

/** Interest of one segment in one topic, 0..1. */
const interest = (segId: string, topic: TopicId) => SEGMENTS.find(x => x.id === segId)!.topics[topic];
const toneMult = (segId: string, tone: Tone) => SEGMENTS.find(x => x.id === segId)!.tones[tone];

function ideologyMult(ideology: string, topic: TopicId): number {
    const i = ideologyById(ideology);
    return i.strong.includes(topic) ? 1.35 : i.weak.includes(topic) ? 0.75 : 1;
}

/** 1-3: pick a card from the hand. */
export function chooseCard(s: SpeechState, index: number): boolean {
    if (s.phase !== "choose" || !s.hand[index]) return false;
    s.chosen = s.hand[index];
    s.phase = "deliver";
    s.phaseTime = 0;
    const r = rng(s);
    newSweet(s, r);
    s.rngState = r.state();
    return true;
}

export function gradeAt(marker: number, sweet: number, half: number): Grade {
    const d = Math.abs(marker - sweet);
    if (d <= half * 0.35) return "perfect";
    if (d <= half * 0.7) return "good";
    if (d <= half) return "weak";
    return "miss";
}

/** SPACE: deliver the line at the marker's current position. */
export function deliver(s: SpeechState): Grade | null {
    if (s.phase !== "deliver" || !s.chosen) return null;
    const g = gradeAt(s.marker, s.sweet, s.sweetHalf);
    resolveBeat(s, g);
    return g;
}

function resolveBeat(s: SpeechState, g: Grade): void {
    const card = s.chosen!;
    const r = rng(s);
    s.lastGrade = g;
    s.grades.push(g);
    if (g === "perfect") { s.combo++; s.fervor = clamp(s.fervor + 0.12 + 0.03 * s.combo, 0, 1); }
    else if (g === "good") { s.fervor = clamp(s.fervor + 0.04, 0, 1); }
    else if (g === "miss") { s.combo = 0; s.fervor = clamp(s.fervor - 0.2, 0, 1); }
    else s.combo = 0;
    const repeat = s.usedTopics.includes(card.topic) ? 0.6 : 1;
    const rebut = s.rival && s.rival.topic === card.topic;
    const regionPull = 0.6 + 0.6 * s.regionTopics[card.topic];
    let best = "", bestGain = -Infinity;
    for (const seg of s.segments) {
        const impact = card.power * GRADE_VALUE[g] * (0.35 + interest(seg.id, card.topic)) * toneMult(seg.id, card.tone)
            * ideologyMult(s.ideology, card.topic) * regionPull * repeat * (1 + s.fervor * 0.5) * (rebut ? 1.3 : 1);
        const gain = 0.22 * impact - 0.15;
        seg.approval = clamp(seg.approval + gain, -1, 1);
        if (gain > bestGain) { bestGain = gain; best = seg.name; }
    }
    s.karma += card.karma;
    s.usedTopics.push(card.topic);
    // The rival speaks too.
    if (s.rival) {
        const rv = s.rival;
        const soft = rebut ? 0.5 : 1;
        for (const seg of s.segments) {
            const impact = (0.8 + rv.skill * 0.08) * (0.35 + interest(seg.id, rv.topic)) * (0.6 + 0.6 * s.regionTopics[rv.topic]) * soft * (0.6 + 0.5 * r.next());
            seg.rival = clamp(seg.rival + 0.22 * impact - 0.15, -1, 1);
        }
        s.log.unshift(rebut ? `You tear apart ${rv.name}'s line on ${card.topic.toUpperCase()}!` : `${rv.name} hammers on ${rv.topic.toUpperCase()}.`);
        const topics = factionById(rv.faction).topics;
        rv.topic = topics.length ? pick(r, topics) : rv.topic;
    }
    const avg = averageApproval(s);
    s.crowd = Math.max(1, Math.round(s.crowd + avg * 5 + s.fervor * 3 - (g === "miss" ? 2 : 0)));
    s.log.unshift(g === "miss" ? `"${card.title}" falls flat.` : `"${card.title}" - ${g.toUpperCase()}! The ${best} ${bestGain > 0.1 ? "roar" : "nod"}.`);
    s.chosen = null;
    // A heckler? More likely when the regime is watching, or a rival has planted people.
    const p = 0.25 + s.heat * 0.25 + (s.rival ? 0.15 : 0);
    if (s.beat < BEATS - 1 && r.next() < p) {
        const lines = ["LIAR!", "Who pays you?", "Go home, agitator!", "Where were you in the floods?", "The Concordat keeps us safe!", "Empty promises!"];
        s.heckler = { key: pick(r, HECKLE_KEYS), line: s.rival ? factionById(s.rival.faction).motto : pick(r, lines), window: 1.6 + 0.2 * s.oratory };
        s.phase = "heckle";
    } else {
        s.phase = "react";
    }
    s.phaseTime = 0;
    s.rngState = r.state();
}

/** The rebuttal key during a heckle. */
export function rebutHeckler(s: SpeechState, key: string): boolean {
    if (s.phase !== "heckle" || !s.heckler) return false;
    const ok = key.toLowerCase() === s.heckler.key;
    for (const seg of s.segments) seg.approval = clamp(seg.approval + (ok ? 0.06 : -0.08), -1, 1);
    s.fervor = clamp(s.fervor + (ok ? 0.1 : -0.1), 0, 1);
    s.log.unshift(ok ? "You silence the heckler. The crowd cheers!" : "You fumble the comeback. Laughter.");
    s.heckler = null;
    s.phase = "react";
    s.phaseTime = 0;
    return ok;
}

export const averageApproval = (s: SpeechState): number => s.segments.reduce((a, seg) => a + seg.approval * seg.share, 0);
const averageRival = (s: SpeechState): number => s.segments.reduce((a, seg) => a + seg.rival * seg.share, 0);

function nextBeat(s: SpeechState): void {
    s.beat++;
    if (s.beat >= BEATS) { finish(s); return; }
    const r = rng(s);
    drawHand(s, r);
    s.rngState = r.state();
    s.phase = "choose";
    s.phaseTime = 0;
    s.lastGrade = null;
}

function finish(s: SpeechState): void {
    const approval = averageApproval(s);
    const delivery = s.grades.reduce((a, g) => a + GRADE_VALUE[g], 0) / Math.max(1, s.grades.length);
    const score = clamp(0.5 + approval * 0.45 + (delivery - 0.6) * 0.35 + s.fervor * 0.1, 0, 1);
    let rival: SpeechResult["rival"] = null;
    if (s.rival) {
        const margin = approval - averageRival(s);
        rival = { faction: s.rival.faction, won: margin > 0, margin };
    }
    const joined = Math.max(0, Math.round(s.crowd * Math.max(0, score - 0.45) * 0.45 * (1 + s.persuasion * 0.12)));
    const approvalBySeg: Record<string, number> = {};
    for (const seg of s.segments) approvalBySeg[seg.id] = seg.approval;
    s.result = { score, crowd: s.crowd, joined, karma: s.karma, approval: approvalBySeg, grades: [...s.grades], rival };
    s.phase = "done";
    s.phaseTime = 0;
    s.log.unshift(score >= 0.8 ? "A triumph! They chant your name." : score >= 0.6 ? "A strong speech. Heads nod across the square." : score >= 0.45 ? "Polite applause." : "The crowd drifts away, unconvinced.");
}

/** Advances timers: the marker sweeps, windows close, the crowd reacts. */
export function stepSpeech(s: SpeechState, dt: number): void {
    if (s.phase === "done") { s.phaseTime += dt; return; }
    s.phaseTime += dt;
    if (s.phase === "choose" && s.phaseTime > CHOOSE_SECONDS) {
        // Hesitation: the weakest card goes out by itself.
        chooseCard(s, s.hand.length - 1);
        s.log.unshift("You hesitate...");
    } else if (s.phase === "deliver") {
        s.marker += s.markerDir * s.markerSpeed * dt;
        if (s.marker >= 1) { s.marker = 2 - s.marker; s.markerDir = -1; }
        if (s.marker <= 0) { s.marker = -s.marker; s.markerDir = 1; }
        if (s.phaseTime > DELIVER_SECONDS) resolveBeat(s, "miss");
    } else if (s.phase === "heckle" && s.heckler && s.phaseTime > s.heckler.window) {
        rebutHeckler(s, "");
    } else if (s.phase === "react" && s.phaseTime > 1.2) {
        nextBeat(s);
    }
}

/** Plays a whole speech with a fixed skill: for tests and the AI (grade per beat, rebut or not). */
export function autoplay(s: SpeechState, pickCard: (s: SpeechState) => number, grade: Grade, rebut = true): SpeechResult {
    let guard = 0;
    while (s.phase !== "done" && guard++ < 1000) {
        if (s.phase === "choose") chooseCard(s, pickCard(s));
        else if (s.phase === "deliver") { resolveBeat(s, grade); }
        else if (s.phase === "heckle") rebutHeckler(s, rebut ? s.heckler!.key : "");
        else stepSpeech(s, 2);
    }
    return s.result!;
}

/** The card a sharp speaker would pick: the best expected approval for this crowd. */
export function bestCard(s: SpeechState): number {
    let best = 0, bestV = -Infinity;
    s.hand.forEach((card, i) => {
        const repeat = s.usedTopics.includes(card.topic) ? 0.6 : 1;
        const rebut = s.rival && s.rival.topic === card.topic ? 1.3 : 1;
        const v = s.segments.reduce((a, seg) => a + seg.share * card.power * (0.35 + interest(seg.id, card.topic)) * toneMult(seg.id, card.tone) * ideologyMult(s.ideology, card.topic), 0)
            * (0.6 + 0.6 * s.regionTopics[card.topic]) * repeat * rebut;
        if (v > bestV) { bestV = v; best = i; }
    });
    return best;
}
