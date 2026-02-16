import { gameState } from "../fps_rpg/state";
import { Faction, factions, quests } from "../fps_rpg/quests";
import { addon } from "./index";

export const renderEngineUI = () => { 
    const windowId = addon.UI.createTab({
        title: "Fractured Realm",
        onRender: () => {  
            Entropy.UI.Widget.label(windowId, { text: "⚔️ THE FRACTURED REALM", bold: true });
            Entropy.UI.Widget.separator(windowId);
            
            if (!gameState.isGameActive) {
                Entropy.UI.Widget.button(windowId, {
                    text: "🎮 Start New Game",
                    onClick: () => {
                        Entropy.setGameMode(true);
                    }
                });
                
                Entropy.UI.Widget.button(windowId, {
                    text: "📂 Load Game",
                    onClick: () => {
                        gameState.load();
                        Entropy.setGameMode(true);
                    }
                });
            } else {
                // Faction reputations
                Entropy.UI.Widget.label(windowId, { text: "=== FACTION STANDING ===", bold: true });
                Object.entries(factions).forEach(([key, faction]) => {
                    if (key !== Faction.NEUTRAL) {
                        const rep = faction.reputation;
                        const status = rep > 50 ? "Allied" : rep > 0 ? "Friendly" : rep > -30 ? "Neutral" : "Hostile";
                        Entropy.UI.Widget.label(windowId, { 
                            text: `${faction.name}: ${rep} (${status})` 
                        });
                    }
                });
                
                Entropy.UI.Widget.separator(windowId);
                
                // Active quests
                Entropy.UI.Widget.label(windowId, { text: "=== ACTIVE QUESTS ===", bold: true });
                if (gameState.activeQuests.length === 0) {
                    Entropy.UI.Widget.label(windowId, { text: "No active quests. Find quest givers!" });
                } else {
                    gameState.activeQuests.forEach(questId => {
                        const quest = quests[questId];
                        Entropy.UI.Widget.label(windowId, { text: `• ${quest.title}` });
                        quest.objectives.forEach((obj, idx) => {
                            const status = quest.completedObjectives[idx] ? "✓" : "○";
                            Entropy.UI.Widget.label(windowId, { text: `  ${status} ${obj}` });
                        });
                    });
                }
                
                Entropy.UI.Widget.separator(windowId);
                
                // Stats
                Entropy.UI.Widget.label(windowId, { text: "=== STATISTICS ===", bold: true });
                Entropy.UI.Widget.label(windowId, { 
                    text: `Artifacts Found: ${gameState.collectablesFound}/5` 
                });
                Entropy.UI.Widget.label(windowId, { 
                    text: `Enemies Defeated: ${Object.values(gameState.enemyKills).reduce((a, b) => a + b, 0)}` 
                });
                
                Entropy.UI.Widget.separator(windowId);
                
                Entropy.UI.Widget.button(windowId, {
                    text: "💾 Save Game",
                    onClick: () => gameState.save()
                });
                
                Entropy.UI.Widget.button(windowId, {
                    text: "🛑 Stop Game",
                    onClick: () => {
                        gameState.save();
                        Entropy.setGameMode(false);
                    }
                });
            }
        }
    });
}