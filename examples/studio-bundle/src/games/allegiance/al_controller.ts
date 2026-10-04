// Gilrs uses the same semantic buttons for Xbox and DualShock controllers, with positive Y up.
export const STICK_DEADZONE = 0.18;
export function stick(value: [number, number]): [number, number] {
    const length = Math.hypot(...value);
    if (!Number.isFinite(length) || length <= STICK_DEADZONE) return [0, 0];
    const scale = Math.min(1, (length - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / length;
    return [value[0] * scale, value[1] * scale];
}
export class Controller {
    left: [number, number] = [0, 0];
    right: [number, number] = [0, 0];
    held = new Set<string>();
    lastAxis = -Infinity;
    axis(left: [number, number], right: [number, number], now: number): void {
        this.left = stick(left); this.right = stick(right); this.lastAxis = now;
    }
    button(button: string, pressed: boolean): boolean {
        const fresh = pressed && !this.held.has(button);
        if (pressed) this.held.add(button); else this.held.delete(button);
        return fresh;
    }
    expire(now: number): void { if (now - this.lastAxis > 0.5) this.reset(); }
    reset(): void { this.left = [0, 0]; this.right = [0, 0]; this.held.clear(); }
}
