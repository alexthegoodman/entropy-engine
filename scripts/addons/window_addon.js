const addon = await Entropy.Addon.register({
    name: "UI Demo",
    version: "1.0.0",
    description: "Demonstrates UI capabilities",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
});

addon.onInit(async () => {
    Entropy.println("UI Demo Initialized!");

    const windowId = Entropy.UI.createWindow({
        title: "My Addon Controls",
        resizable: true,
        defaultSize: { width: 400, height: 300 },
        onRender: (ctx) => {
            Entropy.UI.Widget.label(windowId, {
                text: "Hello from Deno!",
                bold: true
            });

            Entropy.UI.Widget.button(windowId, {
                text: "Click Me",
                onClick: () => {
                    Entropy.println("Button Clicked!");
                }
            });
        }
    });
});
