# Entropy Market (app store / platform)

The marketplace will feature apps that leverage our powerful JavaScript API for creating high-performance native apps (via Deno bridge). 
Some apps may use a web technology approach via our Wry integration, but that will only be for lightweight apps.

- Every semantic handler that your app exposes to the central chat on my platform will be exposed to other apps on the platform.
- Every app gets a cut of the revenue, even free ones (like YouTube) (based on usage ratios)
- Every app uses your Entropy login, no separate logins, no auth processes, as apps are like plugins
- Routing between semantic handlers is uncommon because users don't often add competing tools, but would result in a dialog window

This will ensure a fully integrated platform where all win.

One off-limits area for the platform is automating direct communication (such as email). We do not allow that.
Also, medical apps and sensitive data apps (password managers) are not currently allowed on the platform.

The Deno bridge for native performance isn't about making calendar apps snappier - it's about enabling:

- Game engines that need tight render loops and direct GPU access
- Video editors processing 4K footage in real-time
- 3D modeling tools with complex geometry operations
- Audio workstations with sub-10ms latency requirements
- Code editors/IDEs with deep language server integration
- Data science tools crunching massive datasets

However, in the future, lightweight apps like Calendar or even an Electronics Store could certainly be added to round out the vision.
The point and purpose of using the Deno bridge is for high performance apps, so the app developer is left to their discretion regarding which approach to pick.