// ====================================================================
// COMBAT SYSTEM - Reusable Module
// Handles ranged (raycast) and melee combat for FPS/RPG games
// ====================================================================

export enum WeaponType {
    RANGED = "ranged",
    MELEE = "melee"
}

export interface Weapon {
    type: WeaponType;
    damage: number;
    range: number;
    fireRate: number; // shots/attacks per second
    ammo?: number;
    maxAmmo?: number;
    // Melee specific
    swingArc?: number; // degrees
    swingRadius?: number; // distance
}

export interface CombatEntity {
    id: string;
    health: number;
    maxHealth: number;
    isHostile: boolean;
    lastAttackTime: number;
    weapon: Weapon;
    faction?: string;
    isDead: boolean;
}

interface RaycastHit {
    entityId: string;
    position: [number, number, number];
    distance: number;
}

interface AudioPlayer {
    playSynth(params: any): void;
}

interface VisualEffects {
    spawnImpactEffect(position: [number, number, number]): void;
    spawnMuzzleFlash(position: [number, number, number], direction: [number, number, number]): void;
    spawnBloodEffect(position: [number, number, number]): void;
}

export class CombatSystem {
    private entities: Map<string, CombatEntity> = new Map();
    private audioPlayer?: AudioPlayer;
    private visualEffects?: VisualEffects;
    
    // Callbacks
    public onEntityDeath?: (entityId: string, killerId: string) => void;
    public onEntityDamaged?: (entityId: string, damage: number, killerId: string) => void;
    
    // Entity position providers
    private getEntityPosition: (id: string) => [number, number, number] | null;
    private getCameraTransform: () => [[number, number, number], [number, number, number]];
    
    constructor(
        getEntityPosition: (id: string) => [number, number, number] | null,
        getCameraTransform: () => [[number, number, number], [number, number, number]],
        audioPlayer?: AudioPlayer,
        visualEffects?: VisualEffects
    ) {
        this.getEntityPosition = getEntityPosition;
        this.getCameraTransform = getCameraTransform;
        this.audioPlayer = audioPlayer;
        this.visualEffects = visualEffects;
    }

    private isPlayerId(id: string): boolean {
        // Simple heuristic: if the position provider returns camera transform for this ID, it's the player
        // Better: pass playerId in constructor
        const pos = this.getEntityPosition(id);
        const [camPos] = this.getCameraTransform();
        if (!pos) return false;
        return pos[0] === camPos[0] && pos[1] === camPos[1] && pos[2] === camPos[2];
    }
    
    // ================================================================
    // ENTITY MANAGEMENT
    // ================================================================
    
    registerEntity(id: string, faction: string, weapon: Weapon, maxHealth: number = 100): CombatEntity {
        const entity: CombatEntity = {
            id,
            health: maxHealth,
            maxHealth,
            isHostile: false, // Set by game logic
            lastAttackTime: 0,
            weapon,
            faction,
            isDead: false
        };
        
        this.entities.set(id, entity);
        return entity;
    }
    
    unregisterEntity(id: string): void {
        this.entities.delete(id);
    }
    
    getEntity(id: string): CombatEntity | undefined {
        return this.entities.get(id);
    }
    
    setEntityHostile(id: string, hostile: boolean): void {
        const entity = this.entities.get(id);
        if (entity) {
            entity.isHostile = hostile;
        }
    }
    
    isEntityAlive(id: string): boolean {
        const entity = this.entities.get(id);
        return entity ? !entity.isDead : false;
    }
    
    getAllEntities(): CombatEntity[] {
        return Array.from(this.entities.values());
    }
    
    // ================================================================
    // WEAPON MANAGEMENT
    // ================================================================
    
    setWeapon(entityId: string, weapon: Weapon): void {
        const entity = this.entities.get(entityId);
        if (entity) {
            entity.weapon = weapon;
        }
    }
    
    getWeapon(entityId: string): Weapon | undefined {
        return this.entities.get(entityId)?.weapon;
    }
    
    hasAmmo(entityId: string): boolean {
        const entity = this.entities.get(entityId);
        if (!entity) return false;
        
        if (entity.weapon.type === WeaponType.MELEE) return true;
        return (entity.weapon.ammo || 0) > 0;
    }
    
    reload(entityId: string): boolean {
        const entity = this.entities.get(entityId);
        if (!entity || entity.weapon.type !== WeaponType.RANGED) return false;
        
        if (entity.weapon.maxAmmo) {
            entity.weapon.ammo = entity.weapon.maxAmmo;
            return true;
        }
        
        return false;
    }
    
    // ================================================================
    // COMBAT ACTIONS
    // ================================================================
    
    /**
     * Fire weapon (ranged with raycast or melee swing)
     * Returns true if attack was successful
     */
    attack(entityId: string, isPlayer: boolean = false, overrideOrigin?: [number, number, number], overrideDirection?: [number, number, number]): boolean {
        const entity = this.entities.get(entityId);
        if (!entity || entity.isDead) return false;
        
        // Check fire rate cooldown
        const now = Date.now();
        const minDelay = 1000 / entity.weapon.fireRate;
        if (now - entity.lastAttackTime < minDelay) return false;
        
        // Check ammo for ranged
        if (entity.weapon.type === WeaponType.RANGED) {
            if (!this.hasAmmo(entityId)) {
                this.playEmptySound();
                return false;
            }
            if (entity.weapon.ammo !== undefined) {
                entity.weapon.ammo--;
            }
        }
        
        entity.lastAttackTime = now;
        
        // Perform attack based on type
        if (entity.weapon.type === WeaponType.RANGED) {
            return this.performRangedAttack(entityId, isPlayer, entity, overrideOrigin, overrideDirection);
        } else {
            return this.performMeleeAttack(entityId, entity, overrideOrigin);
        }
    }
    
    /**
     * Ranged attack using raycast (instant hit)
     */
    private performRangedAttack(
        entityId: string, 
        isPlayer: boolean, 
        entity: CombatEntity,
        overrideOrigin?: [number, number, number],
        overrideDirection?: [number, number, number]
    ): boolean {
        let origin: [number, number, number];
        let direction: [number, number, number];
        
        if (overrideOrigin && overrideDirection) {
            origin = overrideOrigin;
            direction = overrideDirection;
            this.playFireSound();
        } else if (isPlayer) {
            [origin, direction] = this.getPlayerAimRay();
            this.playFireSound();
        } else {
            const entityPos = this.getEntityPosition(entityId);
            if (!entityPos) return false;
            
            // Shoot from chest height toward player
            origin = [entityPos[0], entityPos[1] + 1.5, entityPos[2]];
            
            const [playerPos] = this.getCameraTransform();
            const dx = playerPos[0] - origin[0];
            const dy = playerPos[1] - origin[1];
            const dz = playerPos[2] - origin[2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            
            direction = [dx / dist, dy / dist, dz / dist];
            this.playFireSound();
        }
        
        // Muzzle flash
        this.visualEffects?.spawnMuzzleFlash(origin, direction);
        
        // Raycast to find hit
        const hit = this.raycast(origin, direction, entity.weapon.range, entityId);
        
        if (hit) {
            this.handleHit(hit.entityId, entity.weapon.damage, entityId, hit.position);
            return true;
        }
        
        return true; // Attack executed, just missed
    }
    
    /**
     * Melee attack using swing arc detection
     */
    private performMeleeAttack(entityId: string, entity: CombatEntity, overrideOrigin?: [number, number, number]): boolean {
        const entityPos = overrideOrigin || this.getEntityPosition(entityId);
        if (!entityPos) return false;
        
        const swingRadius = entity.weapon.swingRadius || 2.5;
        const swingArc = entity.weapon.swingArc || 90; // degrees
        
        // Get entity facing direction (simplified - you'd get actual rotation)
        // For now, check all entities in radius
        
        let hitAny = false;
        
        for (const [targetId, target] of this.entities.entries()) {
            if (targetId === entityId || target.isDead) continue;
            
            const targetPos = this.getEntityPosition(targetId);
            if (!targetPos) continue;
            
            const dx = targetPos[0] - entityPos[0];
            const dz = targetPos[2] - entityPos[2];
            const dist = Math.sqrt(dx * dx + dz * dz);
            
            if (dist <= swingRadius) {
                // TODO: Check if in swing arc based on facing direction
                this.handleHit(targetId, entity.weapon.damage, entityId, targetPos);
                hitAny = true;
            }
        }
        
        // Swing sound
        this.audioPlayer?.playSynth({
            freq: 200,
            waveform: "saw",
            duration: 0.2,
            gain: 0.3
        });
        
        return hitAny;
    }
    
    /**
     * Raycast through scene to find first entity hit
     * TODO: Should build into more generic library
     */
    private raycast(
        origin: [number, number, number],
        direction: [number, number, number],
        maxRange: number,
        ignoredEntityId: string
    ): RaycastHit | null {
        // Entropy.println("raycast");

        let closestHit: RaycastHit | null = null;
        let closestDist = maxRange;
        
        let x = 0;
        for (const [entityId, entity] of this.entities.entries()) {
            x++;

            // if (x < 3) {
            //     Entropy.println("checking raycast " + origin + " " + entityId + " " + ignoredEntityId + " " + entity.isDead + " " + this.getEntityPosition(entityId));
            // }

            if (entityId === ignoredEntityId || entity.isDead) continue;
            
            const entityPos = this.getEntityPosition(entityId);
            if (!entityPos) {
                // Entropy.println("!entityPos");
                continue;
            };
            
            // Adjust center mass based on whether it's the player or an NPC
            // Player entityPos is camera pos (eye level), NPCs is foot level
            const isTargetPlayer = this.isPlayerId(entityId);
            // const centerOffset = isTargetPlayer ? -0.8 : 1.0; 
            const centerOffset = 0.0;

            // Check if ray intersects entity sphere (radius ~0.8 for more forgiving hits)
            const hit = this.raySphereIntersect(
                origin,
                direction,
                [entityPos[0], entityPos[1] + centerOffset, entityPos[2]],
                5.0
            );
            
            if (hit && hit.distance < closestDist) {
                closestDist = hit.distance;
                closestHit = {
                    entityId,
                    position: hit.point,
                    distance: hit.distance
                };
            }
        }

        Entropy.println("raycast hit " + JSON.stringify(closestHit));
        
        return closestHit;
    }
    
    /**
     * Ray-sphere intersection test
     */
    private raySphereIntersect(
        rayOrigin: [number, number, number],
        rayDir: [number, number, number],
        sphereCenter: [number, number, number],
        sphereRadius: number
    ): { distance: number; point: [number, number, number] } | null {
        const ox = rayOrigin[0] - sphereCenter[0];
        const oy = rayOrigin[1] - sphereCenter[1];
        const oz = rayOrigin[2] - sphereCenter[2];
        
        const a = rayDir[0] * rayDir[0] + rayDir[1] * rayDir[1] + rayDir[2] * rayDir[2];
        const b = 2 * (ox * rayDir[0] + oy * rayDir[1] + oz * rayDir[2]);
        const c = ox * ox + oy * oy + oz * oz - sphereRadius * sphereRadius;
        
        const discriminant = b * b - 4 * a * c;
        
        if (discriminant < 0) return null;
        
        const t = (-b - Math.sqrt(discriminant)) / (2 * a);
        
        if (t < 0) return null;
        
        const point: [number, number, number] = [
            rayOrigin[0] + rayDir[0] * t,
            rayOrigin[1] + rayDir[1] * t,
            rayOrigin[2] + rayDir[2] * t
        ];
        
        return { distance: t, point };
    }
    
    /**
     * Handle entity being hit
     */
    private handleHit(
        targetId: string,
        damage: number,
        attackerId: string,
        hitPosition: [number, number, number]
    ): void {
        const target = this.entities.get(targetId);
        if (!target || target.isDead) return;
        
        // Apply damage
        target.health -= damage;
        
        // Visual feedback
        this.visualEffects?.spawnImpactEffect(hitPosition);
        this.visualEffects?.spawnBloodEffect(hitPosition);
        
        // Callback
        this.onEntityDamaged?.(targetId, damage, attackerId);
        
        // Check death
        if (target.health <= 0 && !target.isDead) {
            target.isDead = true;
            this.onEntityDeath?.(targetId, attackerId);
        }
    }
    
    /**
     * Get player aim ray from camera
     */
    private getPlayerAimRay(): [[number, number, number], [number, number, number]] {
        const [position, direction] = this.getCameraTransform();
        return [position, direction];
    }
    
    // ================================================================
    // NPC COMBAT AI
    // ================================================================
    
    /**
     * Make NPC attack player if conditions are met
     * Call this in NPC update loop
     */
    updateNPCCombat(npcId: string, playerId: string): boolean {
        const npc = this.entities.get(npcId);
        if (!npc || npc.isDead || !npc.isHostile) return false;
        
        const npcPos = this.getEntityPosition(npcId);
        const playerPos = this.getEntityPosition(playerId);
        if (!npcPos || !playerPos) return false;
        
        const dx = playerPos[0] - npcPos[0];
        const dy = playerPos[1] - npcPos[1];
        const dz = playerPos[2] - npcPos[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        // Check if in weapon range
        const inRange = dist <= npc.weapon.range && dist >= 2;
        
        if (inRange) {
            // Try to attack
            return this.attack(npcId, false);
        }
        
        return false;
    }
    
    /**
     * Get direction NPC should face to aim at target
     */
    getAimDirection(npcId: string, targetId: string): number | null {
        const npcPos = this.getEntityPosition(npcId);
        const targetPos = this.getEntityPosition(targetId);
        if (!npcPos || !targetPos) return null;
        
        const dx = targetPos[0] - npcPos[0];
        const dz = targetPos[2] - npcPos[2];
        
        return Math.atan2(dx, dz);
    }
    
    // ================================================================
    // AUDIO
    // ================================================================
    
    playFireSound(): void {
        this.audioPlayer?.playSynth({
            freq: 40,
            waveform: "noise",
            duration: 0.1,
            cutoff: 2000,
            gain: 0.4
        });
    }
    
    playEmptySound(): void {
        this.audioPlayer?.playSynth({
            freq: 1200,
            waveform: "sine",
            duration: 0.05,
            gain: 0.1
        });
    }
    
    playReloadSound(): void {
        this.audioPlayer?.playSynth({
            freq: 880,
            waveform: "square",
            duration: 0.05,
            gain: 0.1
        });
        // cant use setTimeout here
        // setTimeout(() => {
            this.audioPlayer?.playSynth({
                freq: 440,
                waveform: "square",
                duration: 0.1,
                gain: 0.1
            });
        // }, 100);
    }
    
    playDamageSound(): void {
        this.audioPlayer?.playSynth({
            freq: 60,
            waveform: "saw",
            duration: 0.2,
            cutoff: 500,
            gain: 0.3
        });
    }
}