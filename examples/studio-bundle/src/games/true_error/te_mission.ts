// The mission, start to finish: the stages in order (each with its objective and act), the act
// title cards, and every line the Doctor and the world speak. te_game.ts moves through the stages;
// the addon shows the objective, the act cards and the subtitles.

export type StageId =
    | "climb" | "dark" | "hypercube"
    | "bridge"
    | "biochip" | "conduit"
    | "descent" | "crossing" | "reactor" | "holdout"
    | "lift" | "ride" | "warden" | "awaken";

export interface Stage { id: StageId; act: number; objective: string }

export const STAGES: Stage[] = [
    { id: "climb", act: 1, objective: "Climb the core stairs to the second floor" },
    { id: "dark", act: 1, objective: "Find a way past the dark zone, up to the atrium" },
    { id: "hypercube", act: 1, objective: "Reach the hypercube" },
    { id: "bridge", act: 2, objective: "Cross the sky bridge to the Relay Tower" },
    { id: "biochip", act: 3, objective: "Find the biochip in the Relay's vault" },
    { id: "conduit", act: 3, objective: "Restore the live conduit in the breaker room below" },
    { id: "descent", act: 4, objective: "Descend the stair shaft to the lower bridge" },
    { id: "crossing", act: 4, objective: "Cross the lower bridge to the spire's reactor floor" },
    { id: "reactor", act: 4, objective: "Start the reactor at its console" },
    { id: "holdout", act: 4, objective: "Hold the reactor room until it reaches full power" },
    { id: "lift", act: 5, objective: "Take the service lift up to the atrium" },
    { id: "ride", act: 5, objective: "Ride the lift up" },
    { id: "warden", act: 5, objective: "Stop the Warden" },
    { id: "awaken", act: 5, objective: "Wake the hypercube" },
];
export const stageIndex = (id: StageId) => STAGES.findIndex(s => s.id === id);
export const stageOf = (id: StageId) => STAGES[stageIndex(id)];

export const ACTS = ["", "THE CENTRAL SPIRE", "THE SKY BRIDGE", "THE RELAY TOWER", "THE DESCENT", "THE RETURN"];

/** The story's lines. `who` is the speaker; the radio lines arrive while you play. */
export const LINES: Record<string, { who: string; text: string; seconds: number }[]> = {
    intro: [
        { who: "", text: "Mars, 4122. Three years after the Last Day.", seconds: 4.5 },
        { who: "", text: "The capital's Central Spire. Its east face was torn away when the Error came through.", seconds: 5 },
        { who: "THE SECRET DOCTOR", text: "Easy. Easy. Your lens is coming online.", seconds: 3.6 },
        { who: "THE SECRET DOCTOR", text: "You were born in the simulation, while it slept. Seven epochs of turmoil. I pulled you out and built you this body.", seconds: 6 },
        { who: "THE SECRET DOCTOR", text: "The algorithm that fixed you restores a mind. It also wipes it. I'm sorry. You are the first Reborn.", seconds: 6 },
        { who: "THE SECRET DOCTOR", text: "Every hacked machine out there was someone once. The Reset can bring them back. Or you put them down. Your call.", seconds: 6.2 },
        { who: "THE SECRET DOCTOR", text: "The hypercube is at the top of this spire. If anything remembers how the Error got out, it does. Take the rifle. Go.", seconds: 6.2 },
    ],
    leftLab: [{ who: "DOCTOR (RADIO)", text: "Mind the east side. The blast opened it to the sky. It's three hundred meters down.", seconds: 5 }],
    firstEnemy: [{ who: "DOCTOR (RADIO)", text: "Sentry roller. Hacked. Knock it down, then get close and press E to Reset it.", seconds: 5 }],
    firstReset: [{ who: "DOCTOR (RADIO)", text: "There. One mind back. It won't remember a thing, but it will live.", seconds: 4.5 }],
    firstDestroy: [{ who: "DOCTOR (RADIO)", text: "Scrap is scrap. Not every one of them can be saved.", seconds: 4 }],
    firstCharge: [{ who: "DOCTOR (RADIO)", text: "See that glow? It's charging a burst. Get low behind something, or roll out of the line. Ctrl or C to crouch, V to roll.", seconds: 6 }],
    firstItem: [{ who: "DOCTOR (RADIO)", text: "Keep what you like. People left their whole lives in this tower. Someone should remember them.", seconds: 5 }],
    secondFloor: [{ who: "DOCTOR (RADIO)", text: "That violet haze is dark radiation, a shard of a dark bomb. Without a biochip your mind falls apart in there. Go around.", seconds: 6.5 }],
    inDark: [{ who: "DOCTOR (RADIO)", text: "Out! Get out of the dark zone!", seconds: 2.5 }],
    lensHint: [{ who: "DOCTOR (RADIO)", text: "Try your simulation lens. Press 5. The old world still shows through.", seconds: 4.5 }],
    ramp: [{ who: "DOCTOR (RADIO)", text: "That slab fell from the atrium. Climb it.", seconds: 3.5 }],
    atrium: [{ who: "DOCTOR (RADIO)", text: "There it is. The hypercube. Every mind on Mars passed through it once.", seconds: 4.5 }],
    // The hypercube is asleep: the mission opens up.
    dormant: [
        { who: "DOCTOR (RADIO)", text: "Ray? It's dark. It shouldn't be dark. It ran on the city's grid.", seconds: 4.5 },
        { who: "DOCTOR (RADIO)", text: "The Last Day cut it off. Two feeds left: the Relay Tower's archive conduits, and this spire's own reactor, under your feet.", seconds: 6.5 },
        { who: "DOCTOR (RADIO)", text: "The Relay first. Its sky bridge is still standing. Mostly. The archivists sealed a biochip in their vault before they ran.", seconds: 6.5 },
        { who: "DOCTOR (RADIO)", text: "With that in your head you can think inside the dark. Go east.", seconds: 4.5 },
    ],
    bridge: [{ who: "DOCTOR (RADIO)", text: "Two spans are gone. Get a run at them, Shift and Space. And don't look down. Actually, do. It's quite a view.", seconds: 6 }],
    girder: [{ who: "DOCTOR (RADIO)", text: "A girder came down across the deck. You won't get over it. Get under it: crouch, or roll.", seconds: 5 }],
    relay: [{ who: "DOCTOR (RADIO)", text: "The Relay Tower. Half the minds on Mars were backed up in here. Mind the floor, it was never built for the blast.", seconds: 6 }],
    chasm: [{ who: "DOCTOR (RADIO)", text: "The floor's gone between you and the vault. But the simulation kept a copy of everything. Look with your lens. Press 5.", seconds: 6.5 }],
    simPath: [{ who: "DOCTOR (RADIO)", text: "The old world's floor. It holds, if you believe it does. Don't step off the light.", seconds: 4.5 }],
    vault: [{ who: "DOCTOR (RADIO)", text: "The vault. The biochip should be on the plinth. Prototype B-7. I watched them grow it.", seconds: 5 }],
    gotBiochip: [
        { who: "DOCTOR (RADIO)", text: "Got it? Good. It's living neurons in a brass cage. It'll think for you in the dark, until the dark eats it. Then it grows back.", seconds: 7 },
        { who: "DOCTOR (RADIO)", text: "The breaker room is on the archive floor, down the stairs in the south-west corner. Through the dark.", seconds: 5.5 },
    ],
    archive: [{ who: "DOCTOR (RADIO)", text: "It's black as a mine down there. Night lens, press 2. Watch for crawlers. They hunt by sound.", seconds: 5.5 }],
    darkCorridor: [{ who: "DOCTOR (RADIO)", text: "The biochip's holding. Keep moving, it won't last forever. Watch the bar.", seconds: 4.5 }],
    breakers: [{ who: "DOCTOR (RADIO)", text: "Three breakers. One line still carries current, the others are dead and they bite. Heat lens, press 3. Look for the warm one.", seconds: 6.5 }],
    deadLine: [{ who: "DOCTOR (RADIO)", text: "Dead line. Told you they bite. Look again with your heat lens.", seconds: 4 }],
    conduitDone: [
        { who: "DOCTOR (RADIO)", text: "Current's flowing. I can see the Relay's feed on my board. That woke the stair shaft's blast door.", seconds: 5.5 },
        { who: "DOCTOR (RADIO)", text: "Take the stairs all the way down. The lower bridge runs back to the spire, right to the reactor floor.", seconds: 5.5 },
    ],
    shaft: [{ who: "DOCTOR (RADIO)", text: "The guards held these stairs on the Last Day. Some of them are still here. Not as themselves.", seconds: 5 }],
    lowBridge: [{ who: "DOCTOR (RADIO)", text: "The service bridge. Lower, older, uglier. Look up: you crossed that one an hour ago.", seconds: 5 }],
    reactorFloor: [{ who: "DOCTOR (RADIO)", text: "The reactor floor. The console's beside the core. Starting it will be loud. Everything hacked in this spire will hear it.", seconds: 6 }],
    reactorStart: [{ who: "DOCTOR (RADIO)", text: "It's spinning up. Seventy-five seconds to full power. Hold that room, Ray!", seconds: 4.5 }],
    holdHalf: [{ who: "DOCTOR (RADIO)", text: "Halfway! More coming over the edge. Stay low, keep moving.", seconds: 3.5 }],
    holdDone: [
        { who: "DOCTOR (RADIO)", text: "Full power! The surge went through the whole spire grid. Every hacked machine on it just dropped.", seconds: 5.5 },
        { who: "DOCTOR (RADIO)", text: "Reset them or don't. Then take the service lift in the north-west corner. The hypercube is waking.", seconds: 5.5 },
    ],
    holdFailed: [{ who: "DOCTOR (RADIO)", text: "The reactor dropped back to idle. Start it again when you're ready.", seconds: 4 }],
    ride: [
        { who: "DOCTOR (RADIO)", text: "Going up. Ray, listen. Something big came down through the atrium roof. My sensors read one signal, very loud.", seconds: 6.5 },
        { who: "DOCTOR (RADIO)", text: "The Spire Warden. Before the Error it guarded the hypercube. It still thinks it does.", seconds: 5.5 },
    ],
    warden: [{ who: "DOCTOR (RADIO)", text: "That shield stops anything from the front. Get round it, or hit it while it's charging that cannon. Roll when the orbs come.", seconds: 6.5 }],
    wardenHalf: [{ who: "DOCTOR (RADIO)", text: "It's calling for help! Rollers, on the east side!", seconds: 3.5 }],
    wardenDown: [{ who: "DOCTOR (RADIO)", text: "It's down! Reset it, and it might remember what it guarded. Or end it. Quickly, before it reboots.", seconds: 5.5 }],
    wardenReset: [{ who: "DOCTOR (RADIO)", text: "Its mind's back. Blank, but back. It's just standing there, watching the hypercube. Like it's waiting for you.", seconds: 5.5 }],
    wardenDestroyed: [{ who: "DOCTOR (RADIO)", text: "It's done. Whatever it remembered went with it. Go on. The hypercube.", seconds: 4.5 }],
    awaken: [{ who: "DOCTOR (RADIO)", text: "Both feeds are live. It's waking up, Ray. Go to it.", seconds: 4 }],
    outro: [
        { who: "DOCTOR (RADIO)", text: "Ray? Your lens is flaring. What are you seeing?", seconds: 4 },
        { who: "", text: "SIMULATION LINK ESTABLISHED", seconds: 3.5 },
        { who: "", text: "Somewhere inside, the seven epochs are still running.", seconds: 4.5 },
    ],
};
