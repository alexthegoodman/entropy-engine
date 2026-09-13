// Generic 2D collision/hit-testing helpers - no rapier3d involvement, same reasoning as the
// arena shooter's inline version of this (a 3D physics engine is the wrong tool for circle/
// rect overlap tests on a plane). Pulled out into its own module because the level editor needs
// the exact same tests the arena shooter did: click-to-select (point-in-shape) and OnCollide
// (shape-vs-shape).

export function aabbOverlap(
    ax: number, ay: number, aw: number, ah: number,
    bx: number, by: number, bw: number, bh: number,
): boolean {
    return Math.abs(ax - bx) * 2 < (aw + bw) && Math.abs(ay - by) * 2 < (ah + bh);
}

export function circleOverlap(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
    const dx = ax - bx;
    const dy = ay - by;
    const r = ar + br;
    return dx * dx + dy * dy < r * r;
}

export function pointInRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): boolean {
    return Math.abs(px - rx) * 2 < rw && Math.abs(py - ry) * 2 < rh;
}

export function pointInCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy < r * r;
}
