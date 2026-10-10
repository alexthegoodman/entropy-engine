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
import tableLamp from "./table_lamp";
import coffeeMaker from "./coffee_maker";
import domeBuilding from "./dome_building";
import { windowDef, facadeDef } from "./architecture";
import doorDef from "./door";
import houseDef from "./house";
import habLodgeDef from "./hab_lodge";
import wastelandDepotDef from "./wasteland_depot";
import arcaneEmporiumDef from "./arcane_emporium";
import streetCarDef from "./street_car";
import cityBlockDef from "./city_block";
import treeDef from "./tree";
import coniferDef from "./conifer";
import palmDef from "./palm";
import fernDef from "./fern";
import shrubDef from "./shrub";
import grassDef from "./grass";
import flowersDef from "./flowers";
import pottedPlantDef from "./potted_plant";
import humanDef from "./human";
import { handle, hinge } from "./hardware";
import cabinet from "./cabinet";
import chair from "./chair";
import book from "./book";
import shelving from "./shelving";
import crate from "./crate";
import dish from "./dish";
import sofa from "./sofa";

export const LIBRARY: ObjectDef[] = [humanDef, officeChair, table, cabinet, chair, sofa, shelving, bottle, mug, dish, book, crate, tableLamp, coffeeMaker, pottedPlantDef, domeBuilding, houseDef, habLodgeDef, wastelandDepotDef, arcaneEmporiumDef, cityBlockDef, streetCarDef, windowDef, doorDef, facadeDef, gear, bolt, treeDef, coniferDef, palmDef, fernDef, shrubDef, grassDef, flowersDef, rock, leg, rockPiece, caster, handle, hinge];

const BY_ID = new Map(LIBRARY.map(d => [d.id, d]));

export const lookupObject = (id: string): ObjectDef | undefined => BY_ID.get(id);

/** What Add Object lists: everything but components. */
export const browsableObjects = (): ObjectDef[] => LIBRARY.filter(d => !d.component);
