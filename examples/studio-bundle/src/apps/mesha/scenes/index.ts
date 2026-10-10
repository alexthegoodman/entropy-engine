// Mesha's procedural scenes: plain-data SceneDefs (see mesha_scene_def.ts) that place editable
// library objects, configurable through their own parameters like any object.

import type { SceneDef } from "../mesha_scene_def";
import roadToTheDome from "./road_to_the_dome";

export const SCENES: SceneDef[] = [roadToTheDome];

const BY_ID = new Map(SCENES.map(s => [s.id, s]));

export const lookupScene = (id: string): SceneDef | undefined => BY_ID.get(id);
