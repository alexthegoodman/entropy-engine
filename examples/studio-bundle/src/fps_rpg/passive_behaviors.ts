import { entityPositions } from "./index";
import type { Entity } from "../addon";

Entropy.Behavior.register("movement_tracker", {
    onUpdate: (entity: Entity, system: any, state: any) => {
        // Track position for combat system (especially important for Yumon-controlled NPCs)
        entityPositions.set(entity.id, entity.position);
        Entropy.Composer?.updateNPCPosition(entity.id, entity.position);
        // Entropy.println("Update position: " + entity.id + " " + JSON.stringify(entity.position));
        return state;
    }
});