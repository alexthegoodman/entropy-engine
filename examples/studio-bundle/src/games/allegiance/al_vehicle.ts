export interface ParkedCar { x: number; y: number; z: number; yaw: number }

/** Find room for the multicopter's rotor footprint and a player standing beside it. */
export function parkBeside(x: number, z: number, walkable: (x: number, z: number) => boolean,
    height: (x: number, z: number) => number): { player: [number, number]; car: ParkedCar } | null {
    for (let ring = 0; ring <= 15; ring++) {
        const count = ring ? ring * 8 : 1;
        for (let i = 0; i < count; i++) {
            const angle = i * Math.PI * 2 / count;
            const px = x + Math.cos(angle) * ring * 2, pz = z + Math.sin(angle) * ring * 2;
            if (!walkable(px, pz)) continue;
            for (let side = 0; side < 8; side++) {
                const yaw = side * Math.PI / 4;
                const cx = px + Math.sin(yaw) * 4.8, cz = pz + Math.cos(yaw) * 4.8;
                const ground = height(cx, cz);
                let clear = Number.isFinite(ground);
                for (let dx = -3; dx <= 3 && clear; dx++) for (let dz = -3; dz <= 3 && clear; dz++) {
                    if (dx * dx + dz * dz > 12.25) continue;
                    clear = walkable(cx + dx, cz + dz) && Math.abs(height(cx + dx, cz + dz) - ground) < 0.65;
                }
                if (clear) return { player: [px, pz], car: { x: cx, y: ground + 0.22, z: cz, yaw } };
            }
        }
    }
    return null;
}
