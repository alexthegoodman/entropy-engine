import type { ScopedAPI } from "./addon";

export interface DialogueOption {
    text: string;
    next_node: string;
}

export interface DialogueState {
    isOpen: boolean;
    npcName: string;
    text: string;
    options: DialogueOption[];
    selectedIndex: number;
}

export class FPSUI {
    private addon: ScopedAPI;

    constructor(addon: ScopedAPI) {
        this.addon = addon;
    }

    renderHealthBar(health: number, maxHealth: number, x: number = 50, y: number = 50, width: number = 250, height: number = 25) {
        // Background
        this.addon.UI.drawRect({
            position: [x, y],
            size: [width, height],
            color: [0.1, 0.1, 0.1, 0.8],
            strokeThickness: 2,
            strokeColor: [0.8, 0.8, 0.8, 1],
            layer: 100
        });

        // Bar
        const percentage = Math.max(0, Math.min(1, health / maxHealth));
        this.addon.UI.drawRect({
            position: [x, y],
            size: [width * percentage, height],
            color: [1.0, 0.2, 0.2, 1.0],
            layer: 101
        });
        
        // Text (Optional: could add "100/100" text here)
    }

    renderAmmo(ammo: number, maxAmmo?: number, x: number = 50, y: number = 90) {
        const text = maxAmmo !== undefined ? `AMMO: ${ammo} / ${maxAmmo}` : `AMMO: ${ammo}`;
        this.addon.UI.drawText({
            text: text,
            position: [x, y],
            dimensions: [300, 40],
            fontSize: 32,
            color: [1, 1, 1, 1],
            layer: 100
        });
    }

    renderEnemyHealthBar(name: string, health: number, maxHealth: number, screenWidth: number, screenHeight: number) {
        const width = 400;
        const height = 15;
        const x = (screenWidth - width) / 2;
        const y = 60;

        // Name
        this.addon.UI.drawText({
            text: name.toUpperCase(),
            position: [x, y - 30],
            dimensions: [width, 25],
            fontSize: 20,
            color: [1, 1, 1, 1],
            layer: 100
        });

        // Background
        this.addon.UI.drawRect({
            position: [x, y],
            size: [width, height],
            color: [0.1, 0.1, 0.1, 0.8],
            strokeThickness: 1,
            strokeColor: [0.8, 0.8, 0.8, 1],
            layer: 100
        });

        // Bar
        const percentage = Math.max(0, Math.min(1, health / maxHealth));
        this.addon.UI.drawRect({
            position: [x, y],
            size: [width * percentage, height],
            color: [1.0, 0.4, 0.0, 1.0], // Orange-ish for enemies
            layer: 101
        });
    }

    renderCrosshair(screenWidth: number, screenHeight: number, size: number = 24, thickness: number = 2) {
        const x = screenWidth / 2;
        const y = screenHeight / 2;
        
        const color: [number, number, number, number] = [1, 1, 1, 0.9];

        // Vertical
        this.addon.UI.drawRect({
            position: [x - thickness / 2, y - size / 2],
            size: [thickness, size],
            color: color,
            layer: 150
        });

        // Horizontal
        this.addon.UI.drawRect({
            position: [x - size / 2, y - thickness / 2],
            size: [size, thickness],
            color: color,
            layer: 150
        });
        
        // Center Dot
        this.addon.UI.drawRect({
            position: [x - thickness, y - thickness],
            size: [thickness * 2, thickness * 2],
            color: color,
            layer: 151
        });
    }

    renderDialogue(state: DialogueState, screenWidth: number, screenHeight: number) {
        if (!state.isOpen) return;

        const width = 850;
        const height = 220;
        const x = (screenWidth - width) / 2;
        const y = screenHeight - height - 80;

        // Background
        this.addon.UI.drawRect({
            position: [x, y],
            size: [width, height],
            color: [0.05, 0.05, 0.05, 0.9],
            strokeThickness: 2,
            strokeColor: [0.4, 0.6, 1.0, 1],
            layer: 500
        });

        // NPC Name Tag
        if (state.npcName) {
            const nameTagWidth = 200;
            const nameTagHeight = 35;
            this.addon.UI.drawRect({
                position: [x, y - nameTagHeight],
                size: [nameTagWidth, nameTagHeight],
                color: [0.1, 0.2, 0.4, 0.9],
                layer: 500
            });

            this.addon.UI.drawText({
                text: state.npcName.toUpperCase(),
                position: [x + 10, y - nameTagHeight + 5],
                dimensions: [nameTagWidth - 20, 25],
                fontSize: 22,
                color: [1, 1, 1, 1],
                layer: 501
            });
        }

        // Dialogue text
        this.addon.UI.drawText({
            text: state.text,
            position: [x + 30, y + 30],
            dimensions: [width - 60, 80],
            fontSize: 24,
            color: [0.9, 0.9, 0.9, 1],
            layer: 501
        });

        // Options
        state.options.forEach((opt, i) => {
            const isSelected = i === state.selectedIndex;
            this.addon.UI.drawText({
                text: `${isSelected ? "▶ " : "  "}${opt.text}`,
                position: [x + 40, y + 120 + (i * 30)],
                dimensions: [width - 80, 30],
                fontSize: 20,
                color: isSelected ? [1, 1, 0, 1] : [0.7, 0.7, 0.7, 1],
                layer: 501
            });
        });
        
        // Hint
        this.addon.UI.drawText({
            text: "[W/S] Navigate  [ENTER] Select",
            position: [x + width - 250, y + height - 30],
            dimensions: [240, 20],
            fontSize: 14,
            color: [0.5, 0.5, 0.5, 1],
            layer: 501
        });
    }
}
