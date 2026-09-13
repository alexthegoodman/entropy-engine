// Adapts Entropy.Input's event callbacks (onKeyDown/onKeyUp fire once per press/release) into a
// polled "is this held right now" state, which is what a per-frame game loop actually wants for
// movement (mouse position/button state is already polled-friendly via fields, no adapting
// needed there).

export class Input2D {
    private held = new Set<string>();
    mouseX = 0;
    mouseY = 0;
    mouseDown = false;

    constructor() {
        Entropy.Input.onKeyDown((key) => this.held.add(key.toLowerCase()));
        Entropy.Input.onKeyUp((key) => this.held.delete(key.toLowerCase()));
        Entropy.Input.onMouseMove((x, y) => {
            this.mouseX = x;
            this.mouseY = y;
        });
        Entropy.Input.onMouseDown((button) => {
            if (button === 0) this.mouseDown = true;
        });
        Entropy.Input.onMouseUp((button) => {
            if (button === 0) this.mouseDown = false;
        });
    }

    isDown(key: string): boolean {
        return this.held.has(key.toLowerCase());
    }

    // True while the pointer is over any Entropy.UI window/widget - check this before treating
    // mouseDown/mouseX/mouseY as a world click (e.g. click-to-select), or a click on a UI button
    // also fires as a click on whatever's in the game world underneath it. Backed by a real
    // engine-side fix (src/entropy_gui/context.rs's pointer_over_ui, set from every widget's
    // interact() call) - previously there was no such signal at all.
    pointerOverUI(): boolean {
        return Entropy.Input.isPointerOverUI();
    }

    // WASD + arrow keys, each axis in [-1, 1]. Not normalized - callers normalize after adding
    // in whatever else affects movement.
    moveAxis(): [number, number] {
        let x = 0;
        let y = 0;
        if (this.isDown("a") || this.isDown("arrowleft")) x -= 1;
        if (this.isDown("d") || this.isDown("arrowright")) x += 1;
        if (this.isDown("w") || this.isDown("arrowup")) y += 1;
        if (this.isDown("s") || this.isDown("arrowdown")) y -= 1;
        return [x, y];
    }
}
