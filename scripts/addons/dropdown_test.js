const addon = await Entropy.Addon.register({
    name: "Dropdown Test",
    version: "1.0.0",
    description: "Tests dropdown widget",
    author: ["Test"],
    capabilities: {
        ui: true
    }
});

let selected = 0;

addon.onInit(async () => {
    addon.UI.createTab({
        title: "Dropdown Test",
        onRender: () => {
            Entropy.UI.Widget.label("Dropdown Test", "Select an option:");
            Entropy.UI.Widget.dropdown("Dropdown Test", {
                label: "Options",
                options: ["Option A", "Option B", "Option C"],
                selectedIndex: selected,
                onChange: (index) => {
                    Entropy.println("Selected: " + index);
                    selected = parseInt(index);
                }
            });
        }
    });
});
