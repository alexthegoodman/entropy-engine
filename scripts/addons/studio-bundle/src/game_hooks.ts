// Global game hooks for addon integration

const gameEvents = {
    started: [] as (() => void)[],
    stopped: [] as (() => void)[]
};

(Entropy as any).onGameStarted = (cb: () => void) => {
    gameEvents.started.push(cb);
};

(Entropy as any).onGameStopped = (cb: () => void) => {
    gameEvents.stopped.push(cb);
};

(Entropy as any)._dispatchGameStarted = () => {
    Entropy.println("[Game Hooks] Dispatching Game Started");
    gameEvents.started.forEach(cb => {
        try { cb(); } catch(e) { Entropy.println("Error in onGameStarted callback: " + e); }
    });
};

(Entropy as any)._dispatchGameStopped = () => {
    Entropy.println("[Game Hooks] Dispatching Game Stopped");
    gameEvents.stopped.forEach(cb => {
        try { cb(); } catch(e) { Entropy.println("Error in onGameStopped callback: " + e); }
    });
};
