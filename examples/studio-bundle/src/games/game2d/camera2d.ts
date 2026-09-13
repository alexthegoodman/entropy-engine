// Thin wrapper over Entropy.Camera.setOrthographic (new op, see src/core/SimpleCamera.rs and
// src/deno/addon_ops.rs's op_camera_set_orthographic) plus a screen-to-world helper for mouse
// aiming.

export class Camera2D {
    viewHeight: number;

    constructor(viewHeight: number) {
        this.viewHeight = viewHeight;
        Entropy.Camera.setOrthographic(true, viewHeight);
    }

    lookAt(x: number, y: number): void {
        // Position only matters for x/y (orthographic projection is centered on it); z is an
        // arbitrary distance along the camera's look direction, not a zoom control - zoom is
        // viewHeight. Direction is derived from target - position, so target = (x, y, 0) with
        // position.z > 0 gives a straight top-down look-down--Z camera.
        Entropy.Camera.setTransform([x, y, 10], [x, y, 0]);
    }

    // Unprojects a screen pixel onto the world's z=0 plane. Reuses the existing
    // Camera.screenToWorldRay op rather than re-deriving orthographic unprojection locally -
    // that op inverts whatever projection matrix is actually active (see
    // src/deno/addon_engine.rs's `context.camera_proj = camera.get_active_projection()`), so it
    // is already correct for orthographic once that projection is live. What's left to do
    // locally is just the ray/plane intersection, since the op returns a ray, not a point.
    screenToWorld(screenX: number, screenY: number): [number, number] {
        const ray = Entropy.Camera.screenToWorldRay(screenX, screenY);
        const [ox, oy, oz] = ray.origin;
        const [dx, dy, dz] = ray.direction;
        if (Math.abs(dz) < 1e-6) return [ox, oy];
        const t = -oz / dz;
        return [ox + dx * t, oy + dy * t];
    }
}
