# UI Components

Entropy provides a widget-based UI system that integrates directly with the editor's sidebars and windows.

## Creating Containers

### Tabs
Tabs appear in the main editor sidebar.

```javascript
const tab = addon.UI.createTab({
    title: "My Addon",
    onRender: () => {
        Entropy.UI.Widget.label(tab, { text: "Hello World!" });
    }
});
```

### Windows
Windows are floating containers within the editor.

```javascript
const windowId = Entropy.UI.createWindow({
    title: "Diagnostics",
    width: 300,
    height: 200,
    onRender: () => {
        // Render widgets here
    }
});
```

## Widgets

All widgets are rendered using `Entropy.UI.Widget`. Most widgets require a container ID (from a Tab or Window) as their first argument.

### Labels
Simple text display.
```javascript
Entropy.UI.Widget.label(containerId, { text: "Header", bold: true });
```

### Buttons
Trigger actions on click.
```javascript
Entropy.UI.Widget.button(containerId, {
    text: "Spawn Object",
    onClick: () => { /* ... */ }
});
```

### Sliders
Numeric input with a range.
```javascript
Entropy.UI.Widget.slider(containerId, {
    label: "Intensity",
    value: 1.0,
    min: 0.0,
    max: 2.0,
    onChange: (val) => { console.log(parseFloat(val)); }
});
```

### Color Inputs
Standard color picker.
```javascript
Entropy.UI.Widget.colorInput(containerId, {
    label: "Base Color",
    color: [1.0, 0.0, 0.0, 1.0],
    onChange: (color) => { /* color is [r, g, b, a] */ }
});
```

### Checkboxes
Boolean toggles.
```javascript
Entropy.UI.Widget.checkbox(containerId, {
    label: "Enable Shadows",
    value: true,
    onChange: (val) => { /* ... */ }
});
```

## Best Practices

- **Reactive Rendering**: The `onRender` callback is called frequently. Keep your logic inside `onRender` lightweight.
- **State Management**: Keep your addon's state in variables outside the `onRender` function, and update those variables in `onChange` callbacks.
- **Separators**: Use `Entropy.UI.Widget.separator(containerId)` to group related widgets and improve readability.
