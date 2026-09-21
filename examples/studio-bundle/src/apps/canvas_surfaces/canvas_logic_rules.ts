import { logicNode, validateLogic, DEFAULT_NEAR_DISTANCE } from "./canvas_logic";
import type { LogicGraph, LogicNode, LogicWire } from "./canvas_logic";

/** A whole "when X happens, do Y" rule as one value, so a tool call (or a person) never has to place
 * and wire six nodes by hand. Targets and clips are already resolved to ids here; the tool layer does
 * the name lookup. compileRule() only ever produces nodes the editor can draw and validateLogic accepts. */
export type RuleAction =
    | { do: "message"; text: string }
    | { do: "show" | "hide" | "teleport"; target: string }
    | { do: "add"; counter: string; amount?: number }
    | { do: "clip"; clip: string }
    | { do: "wait"; seconds: number };
export interface RuleTrigger { type: "start" | "click" | "near" | "interact"; target?: string; distance?: number; prompt?: string; }
export interface RuleCondition { counter: string; atLeast?: number; below?: number; }
export interface Rule {
    when: RuleTrigger;
    /** The `then` branch runs only the first time per Play. */
    once?: boolean;
    /** All must hold for `then`. `otherwise` needs exactly one, and runs when it does not hold. */
    conditions?: RuleCondition[];
    then: RuleAction[];
    otherwise?: RuleAction[];
}

const COLUMN = 220, ROW = 130;

/** Returns the nodes and wires for one rule, laid out on its own row starting at `row`. */
export function compileRule(rule: Rule, newId: () => string, row: number): LogicGraph {
    const nodes: LogicNode[] = [], connections: LogicWire[] = [];
    const y = 20 + row * ROW;
    const add = (kind: LogicNode["kind"], column: number, lane: number, patch: Partial<LogicNode> = {}): LogicNode => {
        const node = { ...logicNode(newId(), kind, [20 + column * COLUMN, y + lane * 70]), ...patch };
        nodes.push(node); return node;
    };
    const wire = (from: LogicNode, to: LogicNode) => connections.push({ fromNode: from.id, fromPin: "next", toNode: to.id, toPin: "in" });
    const conditions = rule.conditions ?? [];
    if (rule.otherwise?.length && conditions.length !== 1) throw new Error("`otherwise` needs exactly one condition to be the opposite of.");
    if (rule.when.type !== "start" && !rule.when.target) throw new Error(`A "${rule.when.type}" trigger needs a target.`);

    const trigger = add(rule.when.type, 0, 0, { target: rule.when.target ?? "" });
    if (rule.when.type === "near" || rule.when.type === "interact") trigger.amount = rule.when.distance ?? DEFAULT_NEAR_DISTANCE;
    if (rule.when.type === "interact" && rule.when.prompt) trigger.text = rule.when.prompt.slice(0, 60);

    const actions = (list: RuleAction[], from: LogicNode, startColumn: number, lane: number): void => {
        let previous = from, column = startColumn;
        for (const a of list) {
            const node = a.do === "message" ? add("message", column++, lane, { text: a.text })
                : a.do === "add" ? add("add", column++, lane, { variable: a.counter, amount: a.amount ?? 1 })
                : a.do === "clip" ? add("clip", column++, lane, { target: a.clip })
                : a.do === "wait" ? add("wait", column++, lane, { seconds: a.seconds })
                : add(a.do, column++, lane, { target: a.target });
            wire(previous, node); previous = node;
        }
    };

    let head = trigger, column = 1;
    for (const c of conditions) {
        const check = add("check", column++, 0, { variable: c.counter, amount: c.atLeast ?? c.below ?? 1, op: c.below !== undefined && c.atLeast === undefined ? "<" : ">=" });
        wire(head, check); head = check;
    }
    if (rule.once) { const once = add("once", column++, 0); wire(head, once); head = once; }
    actions(rule.then, head, column, 0);
    if (rule.otherwise?.length) {
        const c = conditions[0];
        const inverse = add("check", 1, 1, { variable: c.counter, amount: c.atLeast ?? c.below ?? 1, op: c.below !== undefined && c.atLeast === undefined ? ">=" : "<" });
        wire(trigger, inverse);
        actions(rule.otherwise, inverse, 2, 1);
    }
    return { nodes, connections };
}

/** Compile `rule` onto the end of `graph` (a new row under the existing ones). Throws, leaving `graph`
 * untouched, if the result would be invalid or over the node budget. */
export function appendRule(graph: LogicGraph, rule: Rule, newId: () => string): LogicGraph {
    const row = graph.nodes.length ? Math.floor((Math.max(...graph.nodes.map(n => n.position[1])) - 20) / ROW) + 1 : 0;
    const compiled = compileRule(rule, newId, row);
    const next: LogicGraph = { nodes: [...graph.nodes, ...compiled.nodes], connections: [...graph.connections, ...compiled.connections] };
    validateLogic(next);
    return next;
}
