// Quests: the open world's jobs as data, and a small engine that walks them. A quest is a list
// of stages; each stage waits on one trigger (talk to someone, reach a place, collect so many of
// a thing, kill so many of a tagged group, a flag the game raises, a site interacted with, a
// choice made). The engine never touches the world: the game reports what happened (who was
// talked to, what was interacted with, its counters and flags) and runs the named actions the
// engine hands back (spawn a patrol, play a scene, give a reward). Pure, so the tests can play
// every quest without a window, and saved as plain JSON.
//
// The main quest is one quest among the others: side quests can be taken in any order, before,
// during or after it, and none of them is needed to finish it.

import type { V2 } from "./ab_world";

export type Trigger =
    | { kind: "talk"; npc: string }
    | { kind: "reach"; at: V2; radius: number; /** Only counts while flying (or only on foot). */ air?: boolean; above?: number }
    | { kind: "collect"; counter: string; count: number }
    | { kind: "kill"; tag: string; count: number }
    | { kind: "flag"; flag: string }
    | { kind: "interact"; site: string }
    | { kind: "choice"; id: string };

export interface StageDef {
    id: string;
    /** The objective as the HUD shows it. */
    text: string;
    /** Where the HUD points (null: nowhere). A string names a place the game resolves (an NPC, the creature). */
    marker: V2 | string | null;
    trigger: Trigger;
    /** Actions the game runs when the stage begins and when it is done. */
    enter?: string[];
    done?: string[];
    /** A hint SAGE gives in the journal. */
    hint?: string;
}

export interface Reward { credits?: number; items?: string[]; text: string }

export interface QuestDef {
    id: string;
    title: string;
    kind: "main" | "side";
    /** Who offers it (an NPC id), or null when the world itself starts it (a place, a radio call). */
    giver: string | null;
    /** Where it is offered (for the HUD's quest marker before it starts). */
    offeredAt: V2 | string | null;
    summary: string;
    /** Quests and flags that must be true before it is offered ("quest:id" for a finished quest, "stage:id/stage" once a stage is reached). */
    requires?: string[];
    stages: StageDef[];
    reward: Reward;
}

export type QuestStatus = "locked" | "available" | "active" | "done";

export interface QuestState { id: string; status: QuestStatus; stage: number; /** Counter value when the stage began (collect and kill count from there). */ base: number; outcome: string | null }

/** What the game knows this frame. */
export interface QuestContext {
    pos: [number, number, number];
    flying: boolean;
    /** Ground under the player (for "above" reach triggers). */
    ground: number;
    talked: string | null;
    interacted: string | null;
    chose: { id: string; option: number } | null;
    counters: Record<string, number>;
    flags: Record<string, boolean | number>;
}

export type QuestEvent =
    | { kind: "offered"; quest: QuestDef }
    | { kind: "started"; quest: QuestDef }
    | { kind: "stage"; quest: QuestDef; stage: StageDef }
    | { kind: "completed"; quest: QuestDef; outcome: string | null }
    | { kind: "action"; quest: QuestDef; name: string };

const counterOf = (t: Trigger): string | null => (t.kind === "collect" ? t.counter : t.kind === "kill" ? `kill:${t.tag}` : null);

export class QuestBook {
    readonly states = new Map<string, QuestState>();
    tracked: string | null = null;
    constructor(readonly defs: QuestDef[]) {
        for (const d of defs) this.states.set(d.id, { id: d.id, status: "locked", stage: 0, base: 0, outcome: null });
    }

    def(id: string): QuestDef {
        const d = this.defs.find(q => q.id === id);
        if (!d) throw new Error(`Abyss: no quest ${id}`);
        return d;
    }
    state(id: string): QuestState { return this.states.get(id)!; }
    status(id: string): QuestStatus { return this.states.get(id)?.status ?? "locked"; }
    stage(id: string): StageDef | null {
        const s = this.states.get(id);
        if (!s || s.status !== "active") return null;
        return this.def(id).stages[s.stage] ?? null;
    }
    /** True once a quest has reached (or passed) the named stage. */
    reached(id: string, stageId: string): boolean {
        const s = this.states.get(id);
        if (!s) return false;
        if (s.status === "done") return true;
        if (s.status !== "active") return false;
        const i = this.def(id).stages.findIndex(x => x.id === stageId);
        return i >= 0 && s.stage >= i;
    }
    list(status: QuestStatus): QuestDef[] { return this.defs.filter(d => this.status(d.id) === status); }

    /** The tracked quest's stage (the HUD's objective): the tracked one, else the main quest, else any. */
    focus(): { quest: QuestDef; stage: StageDef } | null {
        const active = this.list("active");
        const pick = active.find(q => q.id === this.tracked) ?? active.find(q => q.kind === "main") ?? active[0];
        if (!pick) return null;
        const stage = this.stage(pick.id);
        return stage ? { quest: pick, stage } : null;
    }

    private requirementMet(r: string, flags: QuestContext["flags"]): boolean {
        if (r.startsWith("quest:")) return this.status(r.slice(6)) === "done";
        if (r.startsWith("stage:")) { const [q, st] = r.slice(6).split("/"); return this.reached(q, st); }
        return !!flags[r];
    }

    /** Offers the quests whose requirements are now met. */
    unlock(flags: QuestContext["flags"]): QuestEvent[] {
        const out: QuestEvent[] = [];
        for (const d of this.defs) {
            const s = this.state(d.id);
            if (s.status !== "locked") continue;
            if ((d.requires ?? []).every(r => this.requirementMet(r, flags))) { s.status = "available"; out.push({ kind: "offered", quest: d }); }
        }
        return out;
    }

    /** Starts an available quest (talking to its giver, or the world starting it). */
    start(id: string, ctx: Pick<QuestContext, "counters">): QuestEvent[] {
        const s = this.state(id);
        if (s.status !== "available") return [];
        s.status = "active";
        s.stage = 0;
        const d = this.def(id);
        if (!this.tracked || this.status(this.tracked) !== "active" || d.kind === "main") this.tracked = id;
        return [{ kind: "started", quest: d }, ...this.enterStage(d, s, ctx)];
    }

    private enterStage(d: QuestDef, s: QuestState, ctx: Pick<QuestContext, "counters">): QuestEvent[] {
        const st = d.stages[s.stage];
        const c = counterOf(st.trigger);
        s.base = st.trigger.kind === "kill" && c ? ctx.counters[c] ?? 0 : 0;
        return [{ kind: "stage", quest: d, stage: st }, ...(st.enter ?? []).map(name => ({ kind: "action" as const, quest: d, name }))];
    }

    /** Progress toward a collect or kill stage: [have, need], or null. */
    progress(id: string, counters: Record<string, number>): [number, number] | null {
        const st = this.stage(id);
        if (!st) return null;
        const t = st.trigger;
        if (t.kind === "collect") return [Math.min(t.count, counters[t.counter] ?? 0), t.count];
        if (t.kind === "kill") return [Math.min(t.count, (counters[`kill:${t.tag}`] ?? 0) - this.state(id).base), t.count];
        return null;
    }

    private met(id: string, t: Trigger, ctx: QuestContext): boolean {
        switch (t.kind) {
            case "talk": return ctx.talked === t.npc;
            case "reach": {
                const d = Math.hypot(ctx.pos[0] - t.at[0], ctx.pos[2] - t.at[1]);
                if (d > t.radius) return false;
                if (t.air === true && !ctx.flying) return false;
                if (t.air === false && ctx.flying) return false;
                if (t.above !== undefined && ctx.pos[1] < t.above) return false;
                return true;
            }
            case "collect": return (ctx.counters[t.counter] ?? 0) >= t.count;
            case "kill": return (ctx.counters[`kill:${t.tag}`] ?? 0) - this.state(id).base >= t.count;
            case "flag": return !!ctx.flags[t.flag];
            case "interact": return ctx.interacted === t.site;
            case "choice": return ctx.chose?.id === t.id;
        }
    }

    /**
     * One step: offers what is now unlocked, then moves every active quest on as far as its
     * triggers allow this frame (a stage met on entry passes straight through).
     */
    step(ctx: QuestContext): QuestEvent[] {
        const out = this.unlock(ctx.flags);
        for (const d of this.defs) {
            const s = this.state(d.id);
            let guard = 0;
            while (s.status === "active" && guard++ < d.stages.length + 1) {
                const st = d.stages[s.stage];
                if (!this.met(d.id, st.trigger, ctx)) break;
                if (st.trigger.kind === "choice" && ctx.chose) s.outcome = `${st.trigger.id}:${ctx.chose.option}`;
                out.push(...(st.done ?? []).map(name => ({ kind: "action" as const, quest: d, name })));
                // A talk, an interaction or a choice is used up by the stage it finishes.
                if (st.trigger.kind === "talk") ctx = { ...ctx, talked: null };
                if (st.trigger.kind === "interact") ctx = { ...ctx, interacted: null };
                if (st.trigger.kind === "choice") ctx = { ...ctx, chose: null };
                if (s.stage + 1 >= d.stages.length) {
                    s.status = "done";
                    out.push({ kind: "completed", quest: d, outcome: s.outcome });
                    if (this.tracked === d.id) this.tracked = this.list("active").find(q => q.kind === "main")?.id ?? this.list("active")[0]?.id ?? null;
                } else {
                    s.stage++;
                    out.push(...this.enterStage(d, s, ctx));
                }
            }
        }
        // What finishing a quest just unlocked is offered now, not a frame later.
        out.push(...this.unlock(ctx.flags));
        return out;
    }

    /** Cycles the tracked quest through the active ones. */
    cycleTracked(): string | null {
        const active = this.list("active");
        if (!active.length) return (this.tracked = null);
        const i = active.findIndex(q => q.id === this.tracked);
        this.tracked = active[(i + 1) % active.length].id;
        return this.tracked;
    }

    save(): { states: QuestState[]; tracked: string | null } {
        return { states: [...this.states.values()].map(s => ({ ...s })), tracked: this.tracked };
    }
    load(d: { states: QuestState[]; tracked: string | null }): void {
        for (const s of d.states) if (this.states.has(s.id)) this.states.set(s.id, { ...s });
        this.tracked = d.tracked;
    }
}
