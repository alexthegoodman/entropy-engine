// One window, one 3D view: the camera, the orbit control, the sun and the gizmo are engine-wide, so in
// the Creative Suite Mesha and the Game World Detailer take turns with them. Each calls claimView at
// the top of its onUpdate (which only runs while its tab is the active one); `takeOver` runs on the
// first frame after another app had the view, to put back its own camera, control, light and gizmo.
// Apps that never touch the 3D view (DAW, Planner, CC Manager) don't claim it, so a trip through them
// costs nothing. Standalone, the only claimant takes over once, on its first frame.

type V3 = [number, number, number];
interface OrbitState { format: string; position: V3; target: V3; distance: number; yaw: number; pitch: number; options?: { addonName?: string | null } }

const owner = globalThis as { __entropyViewOwner?: string };
const orbit = (): OrbitState | null => (Entropy.Controls as unknown as { _state?: OrbitState | null })._state ?? null;

/** True on the frame `app` took the view over from another app (after running `takeOver`). */
export function claimView(app: string, takeOver: () => void): boolean {
    if (owner.__entropyViewOwner === app) return false;
    owner.__entropyViewOwner = app;
    takeOver();
    return true;
}

/** The orbit control's camera, if the control is `app`'s (native reads lag a frame and give a direction, not a target). */
export function orbitView(app: string): { pos: V3; target: V3 } | null {
    const st = orbit();
    if (st?.format !== "orbit" || st.options?.addonName !== app || !st.position || !st.target) return null;
    return { pos: [...st.position], target: [...st.target] };
}

/** Controls.enable seeds itself from the native camera, which hasn't taken a move made this frame: seed it here. */
export function seedOrbit(pos: V3, target: V3): void {
    const st = orbit();
    if (!st) return;
    const dx = pos[0] - target[0], dy = pos[1] - target[1], dz = pos[2] - target[2];
    st.position = [...pos];
    st.target = [...target];
    st.distance = Math.max(0.001, Math.hypot(dx, dy, dz));
    st.yaw = Math.atan2(dz, dx);
    st.pitch = Math.asin(Math.max(-1, Math.min(1, dy / st.distance)));
}
