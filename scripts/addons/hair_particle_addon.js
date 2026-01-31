const addon = await Entropy.Addon.register({
    name: "Hair Particles",
    version: "1.0.0",
    description: "Fine-tune hair and grass particles in a dedicated workspace",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let hairParams = {
    gridSize: 2.0,
    renderDistance: 50.0,
    windStrength: 2.5,
    windSpeed: 0.3,
    bladeHeight: 2.75,
    bladeWidth: 0.03,
    brownianStrength: 0.03,
    bladeDensity: 15.0,
    landscapeSize: 100.0,
    landscapeHeight: 0.0,
    landscapeYOffset: 0.0
};

function updateHair() {
    addon.Particles.createHair(hairParams);
}

Entropy.Addon.onInit(async () => {
    Entropy.println("Hair Particle Addon Initializing...");
    updateHair();

    const tab = Entropy.UI.createTab({
        title: "Hair Settings",
        onRender: async () => {
            Entropy.UI.Widget.label(tab, { text: "Hair & Grass Fine-tuning", bold: true });
            
            Entropy.UI.Widget.label(tab, `Density: ${hairParams.bladeDensity}`);
            Entropy.UI.Widget.button(tab, {
                text: "Increase Density",
                onClick: () => {
                    hairParams.bladeDensity += 5;
                    updateHair();
                }
            });
            Entropy.UI.Widget.button(tab, {
                text: "Decrease Density",
                onClick: () => {
                    hairParams.bladeDensity = Math.max(1, hairParams.bladeDensity - 5);
                    updateHair();
                }
            });

            Entropy.UI.Widget.label(tab, `Height: ${hairParams.bladeHeight.toFixed(2)}`);
            Entropy.UI.Widget.button(tab, {
                text: "Taller",
                onClick: () => {
                    hairParams.bladeHeight += 0.25;
                    updateHair();
                }
            });
            Entropy.UI.Widget.button(tab, {
                text: "Shorter",
                onClick: () => {
                    hairParams.bladeHeight = Math.max(0.1, hairParams.bladeHeight - 0.25);
                    updateHair();
                }
            });

            Entropy.UI.Widget.label(tab, `Wind Strength: ${hairParams.windStrength.toFixed(2)}`);
            Entropy.UI.Widget.button(tab, {
                text: "Stronger Wind",
                onClick: () => {
                    hairParams.windStrength += 0.5;
                    updateHair();
                }
            });
            Entropy.UI.Widget.button(tab, {
                text: "Calmer Wind",
                onClick: () => {
                    hairParams.windStrength = Math.max(0, hairParams.windStrength - 0.5);
                    updateHair();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "Reset to Defaults",
                onClick: () => {
                    hairParams = {
                        gridSize: 2.0,
                        renderDistance: 50.0,
                        windStrength: 2.5,
                        windSpeed: 0.3,
                        bladeHeight: 2.75,
                        bladeWidth: 0.03,
                        brownianStrength: 0.03,
                        bladeDensity: 15.0,
                        landscapeSize: 100.0,
                        landscapeHeight: 0.0,
                        landscapeYOffset: 0.0
                    };
                    updateHair();
                }
            });
        }
    });
});
