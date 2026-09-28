// Mesha's procedural object library. Each entry is a plain-data ObjectDef (JSON-serializable, see
// tests/mesha.test.ts); components are building blocks other objects compose.

import type { ObjectDef } from "../mesha_object";
import leg from "./leg";
import table from "./table";
import bottle from "./bottle";
import gear from "./gear";
import bolt from "./bolt";
import rock, { rockPiece } from "./rock";
import officeChair, { caster } from "./office_chair";
import mug from "./mug";
import { windowDef, facadeDef } from "./architecture";

export const LIBRARY: ObjectDef[] = [officeChair, table, bottle, mug, windowDef, facadeDef, gear, bolt, rock, leg, rockPiece, caster];

const BY_ID = new Map(LIBRARY.map(d => [d.id, d]));

export const lookupObject = (id: string): ObjectDef | undefined => BY_ID.get(id);

/** What Add Object lists: everything but components. */
export const browsableObjects = (): ObjectDef[] => LIBRARY.filter(d => !d.component);
