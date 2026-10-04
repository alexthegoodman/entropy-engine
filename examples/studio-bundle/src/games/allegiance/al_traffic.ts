// Sparse, capped aerial traffic. Housing density is measured locally, rather than city population.
export const TRAFFIC_LIMIT = 12;
export function trafficCount(houses: number, radius = 400): number {
    if (houses <= 0) return 0;
    const perKm2 = houses / (Math.PI * (radius / 1000) ** 2);
    return Math.min(TRAFFIC_LIMIT, Math.max(1, Math.round(Math.sqrt(perKm2) / 3)));
}
/** Houses count directly; tall blocks contribute an apartment-density estimate from floor area. */
export function housingUnits(buildings: Array<{ kind: string; width: number; depth: number; height: number }>): number {
    return buildings.reduce((units, b) => units + (b.kind === "house" ? 1
        : Math.max(1, b.width * b.depth * Math.max(1, b.height / 3) / 90) * 0.35), 0);
}
export function trafficPose(index: number, time: number, x: number, z: number, rooftop: number) {
    const angle = index * 2.399963;
    const radius = 100 + (index % 4) * 55;
    const phase = time * (0.018 + index * 0.001) + angle;
    // Some vehicles hover while others circulate in separated altitude lanes.
    const hover = index % 4 === 0;
    const yaw = hover ? angle : phase;
    return { x: x + Math.cos(hover ? angle : phase) * radius,
        z: z + Math.sin(hover ? angle : phase) * radius,
        y: rooftop + 22 + (index % 3) * 12 + Math.sin(time * 1.3 + index) * 0.3, yaw };
}
