const addon = await Entropy.Addon.register({
    name: "Tabs Demo",
    version: "1.0.0",
    description: "Demonstrates Workspace Tabs",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
});

addon.onInit(async () => {
    Entropy.println("Tabs Demo Initialized!");

    // Tab 1
    const tab1 = addon.UI.createTab({
        title: "Tab One",
        onRender: () => {
            Entropy.UI.Widget.label(tab1, {
                text: "Welcome to Tab One!",
                bold: true
            });
            Entropy.UI.Widget.button(tab1, {
                text: "Button 1"
            });
        }
    });

    // Tab 2
    const tab2 = addon.UI.createTab({
        title: "Tab Two",
        onRender: () => {
            Entropy.UI.Widget.label(tab2, {
                text: "This is Tab Two."
            });
            Entropy.UI.Widget.label(tab2, {
                text: "It has different content.",
                bold: true
            });
             Entropy.UI.Widget.button(tab2, {
                text: "Button 2"
            });
        }
    });
});
