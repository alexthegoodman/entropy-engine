# Introduction

Welcome to the **Entropy Book**, the comprehensive guide to developing and extending the Entropy Engine.

## What is Entropy?

Entropy is a high-performance native editor and engine designed for creating videos, games, and interactive experiences. It leverages Rust and `wgpu` for the core engine capabilities while providing a powerful, easy-to-use JavaScript/TypeScript API for creating "Addons".

### The Addon Philosophy

Unlike traditional engines where you might need to modify the core to add new features, Entropy is built around an **Addon-First** architecture. Almost every feature in the editor—from the terrain generator and water simulation to the synth and environment controls—is implemented as an addon.

Addons in Entropy are:
- **Portable**: Written in JavaScript or TypeScript.
- **Performant**: Able to register custom `wgpu` pipelines and shaders.
- **Interactive**: Integrated directly into the editor's UI system.
- **Powerful**: Able to leverage LLM-driven "Tools" for agentic interaction.

## What's in this Book?

This book is divided into several sections:

1. **Addon Development**: Learn how to create your first addon, register it, and use the Entropy API.
2. **API Reference**: Detailed documentation of all available global objects and methods.
3. **Engine Architecture**: Deep dives into how the underlying Rust engine works, for those who want to contribute to the core or understand the "magic".

Let's get started!
