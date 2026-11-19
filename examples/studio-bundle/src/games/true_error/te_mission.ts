// The missions, start to finish: the stages in order (each with its mission, act and objective),
// the act title cards, and every line the Doctor and the world speak. te_game.ts (te_m2.ts for
// Noctis) moves through the stages; the addon shows the objective, the act cards and the subtitles.

export type StageId =
    | "climb" | "dark" | "hypercube"
    | "bridge"
    | "biochip" | "conduit"
    | "descent" | "crossing" | "reactor" | "holdout"
    | "lift" | "ride" | "warden" | "awaken"
    // Mission 2, Noctis.
    | "embark" | "noctis" | "silence" | "camp" | "signal" | "beacons" | "survivors"
    | "tithe" | "descend" | "undercroft" | "nest" | "tunnel" | "ascent" | "rim";

export interface Stage { id: StageId; mission: number; act: number; objective: string }

export const STAGES: Stage[] = [
    { id: "climb", mission: 1, act: 1, objective: "Climb the core stairs to the second floor" },
    { id: "dark", mission: 1, act: 1, objective: "Find a way past the dark zone, up to the atrium" },
    { id: "hypercube", mission: 1, act: 1, objective: "Reach the hypercube" },
    { id: "bridge", mission: 1, act: 2, objective: "Cross the sky bridge to the Relay Tower" },
    { id: "biochip", mission: 1, act: 3, objective: "Find the biochip in the Relay's vault" },
    { id: "conduit", mission: 1, act: 3, objective: "Restore the live conduit in the breaker room below" },
    { id: "descent", mission: 1, act: 4, objective: "Descend the stair shaft to the lower bridge" },
    { id: "crossing", mission: 1, act: 4, objective: "Cross the lower bridge to the spire's reactor floor" },
    { id: "reactor", mission: 1, act: 4, objective: "Start the reactor at its console" },
    { id: "holdout", mission: 1, act: 4, objective: "Hold the reactor room until it reaches full power" },
    { id: "lift", mission: 1, act: 5, objective: "Take the service lift up to the atrium" },
    { id: "ride", mission: 1, act: 5, objective: "Ride the lift up" },
    { id: "warden", mission: 1, act: 5, objective: "Stop the Warden" },
    { id: "awaken", mission: 1, act: 5, objective: "Wake the hypercube" },
    { id: "embark", mission: 2, act: 1, objective: "Talk to the Doctor at his rover" },
    { id: "noctis", mission: 2, act: 2, objective: "The Foundry, Gate Four and the barge, in any order" },
    { id: "silence", mission: 2, act: 3, objective: "The Doctor isn't answering. Get back to his camp" },
    { id: "camp", mission: 2, act: 3, objective: "Search the camp" },
    { id: "signal", mission: 2, act: 4, objective: "Follow the distress call to the pumphouse on the canal" },
    { id: "beacons", mission: 2, act: 4, objective: "Destroy the lure beacons around the pumphouse" },
    { id: "survivors", mission: 2, act: 4, objective: "Talk to the survivors in the pumphouse" },
    { id: "tithe", mission: 2, act: 5, objective: "Follow Vesper to the quarry lift" },
    { id: "descend", mission: 2, act: 5, objective: "Ride the lift down" },
    { id: "undercroft", mission: 2, act: 6, objective: "Find a way out of the Undercroft" },
    { id: "nest", mission: 2, act: 6, objective: "Destroy the cable heart grown into the tunnel door" },
    { id: "tunnel", mission: 2, act: 6, objective: "Follow the metro tunnel to the maintenance hoist" },
    { id: "ascent", mission: 2, act: 6, objective: "Ride the hoist up" },
    { id: "rim", mission: 2, act: 6, objective: "Get past the Tithe and out to the canyon rim" },
];
export const stageIndex = (id: StageId) => STAGES.findIndex(s => s.id === id);
export const stageOf = (id: StageId) => STAGES[stageIndex(id)];
/** The first stage of each mission. */
export const MISSION_START: Record<number, StageId> = { 1: "climb", 2: "embark" };
export const MISSION_NAMES = ["", "THE CENTRAL SPIRE", "NOCTIS"];

export const ACTS = ["", "THE CENTRAL SPIRE", "THE SKY BRIDGE", "THE RELAY TOWER", "THE DESCENT", "THE RETURN"];
export const ACTS2 = ["", "THE FOOT OF THE SPIRE", "THE CANYON FLOOR", "RADIO SILENCE", "THE PUMPHOUSE", "THE TITHE", "THE UNDERCROFT"];
export const actName = (mission: number, act: number) => (mission === 2 ? ACTS2 : ACTS)[act] ?? "";

/** Mission 2, Noctis: from the foot of the spire to the canyon rim. */
const DOC = "DOCTOR (RADIO)";
const LINES2: Record<string, { who: string; text: string; seconds: number }[]> = {
    intro2: [
        { who: "", text: "Noctis Labyrinthus. The canyon floor beneath the capital.", seconds: 4.5 },
        { who: "", text: "When the hypercube woke, it showed the Doctor everything it remembered. For one second.", seconds: 5 },
        { who: "THE SECRET DOCTOR", text: "Three places down here lit up in that second. Three places it wanted us to see.", seconds: 5 },
        { who: "THE SECRET DOCTOR", text: "The Avatar Foundry, to the east. They built the bodies there. The ones the dead came home in.", seconds: 5.5 },
        { who: "THE SECRET DOCTOR", text: "Gate Four, to the west, where the first of them walked out. And the barge on the old canal, south. Its mast is the last radio on Mars with any reach.", seconds: 7 },
        { who: "THE SECRET DOCTOR", text: "I'll stay with the rover and keep the line open. Come here before you go.", seconds: 4.5 },
    ],
    embark: [
        { who: "THE SECRET DOCTOR", text: "Take this. A scattergun. Ugly, close and loud. The things down here don't keep their distance.", seconds: 5.5 },
        { who: "THE SECRET DOCTOR", text: "Q swaps what you're holding. And crouch more. A machine that hasn't seen you can be put down from behind before it ever turns around.", seconds: 6.5 },
        { who: "THE SECRET DOCTOR", text: "Any order you like. I'll be right here.", seconds: 3.5 },
    ],
    takedownHint: [{ who: DOC, text: "It hasn't seen you. Stay low, get behind it, and press E.", seconds: 4.5 }],
    firstTakedown: [{ who: DOC, text: "Quietly done. It'll stay down long enough for a Reset.", seconds: 4 }],
    // The Avatar Foundry.
    foundry: [{ who: DOC, text: "The Avatar Foundry. Robots built bodies here for forty years. On the Last Day it built them for the dead.", seconds: 6 }],
    foundryRoutes: [{ who: DOC, text: "The loading bay is the front door, and something's watching it. There's a culvert under the south wall, and the north wall is half down. Your pick.", seconds: 7 }],
    firstHollow: [{ who: DOC, text: "That's a Hollow. A body nobody ever got into. Something wears it anyway. They only move when you aren't looking at them. So look.", seconds: 7 }],
    foundryInside: [{ who: DOC, text: "It's still printing. Three years and the line never stopped. The control pulpit is at the far end.", seconds: 5.5 }],
    launcher: [{ who: DOC, text: "The foreman's locker. Is that a gravity launcher? Take it. Point it at a crowd and stand well back.", seconds: 5.5 }],
    printerOff: [{ who: DOC, text: "Line's down. Ray... the racks. They're climbing off the racks.", seconds: 4.5 }],
    foundryEcho: [
        { who: "ECHO  -  LINE FOREMAN", text: "Order nine-one-one. Four thousand bodies, rush job, paid in full by the Gate. We didn't ask who for. You don't ask who's coming home.", seconds: 7 },
        { who: DOC, text: "Four thousand. That's how many came through. Keep going.", seconds: 4 },
    ],
    // Gate Four.
    gate: [{ who: DOC, text: "Gate Four. I queued here once. Everyone did. You paid, you sat down, you visited your dead for an afternoon.", seconds: 6 }],
    cherubs: [{ who: DOC, text: "Gate cherubs. They used to sing to the people in the queue. Don't let them get above you, they dive.", seconds: 5.5 }],
    gateDark: [{ who: DOC, text: "The gate's heart is in dark radiation. Your biochip will carry you for a while. Watch the bar.", seconds: 5 }],
    gateTerminals: [{ who: DOC, text: "Three terminals, and only one ran the gate's last session. Your simulation lens shows the old queue. Follow it to the right one.", seconds: 6.5 }],
    wrongTerminal: [{ who: DOC, text: "Wrong one, and everything heard it. The lens, Ray. Follow the queue.", seconds: 4.5 }],
    gateLog: [
        { who: "ECHO  -  GATE FOUR", text: "Final session. Outbound: four thousand and eleven. Authorized by: S.", seconds: 5.5 },
        { who: DOC, text: "S. That's not... no. It can't be. Leave it with me. Let's finish what we came for.", seconds: 5.5 },
    ],
    // The barge and its mast.
    barge: [{ who: DOC, text: "The barge Patience. It was carrying meltwater from the pole when the Last Day dropped it in the canal. Her crew broadcast warnings until the end.", seconds: 7 }],
    canal: [{ who: DOC, text: "The canal is a road now. Low and quiet. Fewer eyes down there, but the crawlers nest in it.", seconds: 5 }],
    mast: [{ who: DOC, text: "The mast's winch is on the quay. Hold E to crank it. It won't be quiet.", seconds: 4.5 }],
    mastHalf: [{ who: DOC, text: "Halfway. Keep cranking. Something's coming out of the hull.", seconds: 4 }],
    mastUp: [{ who: DOC, text: "Mast's up. I can hear static from halfway round the planet. Static, Ray, not silence. Someone out there is still talking.", seconds: 6.5 }],
    // The Doctor is taken.
    allDone: [
        { who: DOC, text: "That's all three. Come back to the rover, I want to show you something in that gate log.", seconds: 5.5 },
        { who: DOC, text: "Ray, there's someone at the camp. There's someone at the-", seconds: 3.6 },
        { who: "RADIO", text: "(static)", seconds: 2.5 },
    ],
    camp: [
        { who: "RAY", text: "Doctor?", seconds: 2.2 },
        { who: "", text: "The rover is on its side. Drag marks run east into the dust, then stop, as if he was lifted.", seconds: 5.5 },
    ],
    radio: [
        { who: "RAY", text: "Anyone on this frequency. This is Ray. I need help.", seconds: 4 },
        { who: "RADIO", text: "...anyone... the pumphouse, west end of the canal... they're at the doors, please, we have a child...", seconds: 6 },
        { who: "RAY", text: "I'm coming.", seconds: 2.2 },
    ],
    // The pumphouse.
    pods: [{ who: "RAY", text: "They're people. Wired in. Still breathing.", seconds: 4 }],
    beaconHint: [{ who: "MARA (RADIO)", text: "The towers with the red light! They call the Hollows. Break them and the Hollows forget we're here!", seconds: 5.5 }],
    beaconsDone: [{ who: "MARA (RADIO)", text: "They're wandering off. They're leaving! The door's open. Come in, quickly.", seconds: 4.5 }],
    survivors: [
        { who: "MARA", text: "You're a Reborn. I didn't think the Doctor's story was true.", seconds: 4.5 },
        { who: "ODUYA", text: "Those pods out there were our street. The Error comes at night and takes whoever sleeps too deep. It feeds them to the Foundry. New bodies need old minds.", seconds: 8 },
        { who: "PIP", text: "Your lens is like mine. Are you a person too?", seconds: 3.6 },
        { who: "MARA", text: "A man in a long coat? We haven't seen him. But the Tithe would know. They trade with whatever comes out of the dark.", seconds: 6 },
    ],
    tithe: [
        { who: "VESPER", text: "Well. A Reborn. The stories never said you'd be so gentle with Hollows.", seconds: 4.5 },
        { who: "VESPER", text: "Your Doctor? Long coat, bad temper? My people saw him carried to the quarry lift at dusk. We can take you down. We look after each other in this canyon.", seconds: 7.5 },
        { who: "MARA", text: "Ray. Be careful with them.", seconds: 3 },
    ],
    vesperWalk: [{ who: "VESPER", text: "Three years we've kept this canyon. You learn what the dark wants, and you give it a little less than that.", seconds: 6 }],
    trap: [
        { who: "VESPER", text: "Nothing personal, Reborn. The Error pays for minds like yours. One Reset-mind buys my people a year without a night raid.", seconds: 7 },
        { who: "VESPER", text: "If it helps, he really was taken. Just not down there.", seconds: 4 },
        { who: "", text: "The gate slams shut overhead.", seconds: 3 },
    ],
    // The Undercroft.
    undercroft: [
        { who: "", text: "The Undercroft. The Tithe's side of the bargain.", seconds: 4 },
        { who: "RAY", text: "No radio down here. Fine. Then I find my own way out.", seconds: 4 },
    ],
    pit: [{ who: "", text: "Pods in rows, hundreds of them, humming. A whole district, asleep.", seconds: 4.5 }],
    nest: [
        { who: "RAY", text: "That's what's holding the tunnel door. It's grown right into the locks.", seconds: 4.5 },
        { who: "RAY", text: "Its shell opens when it breathes. Hit the core then. Or tear it open with a gravity grenade.", seconds: 5.5 },
    ],
    nestDown: [{ who: "RAY", text: "The door's free. A metro line, running south. Nobody's ridden it in years.", seconds: 4.5 }],
    hoist: [{ who: "", text: "A maintenance hoist, still wired to the reactor's trickle. It goes all the way up.", seconds: 4.5 }],
    ascent: [
        { who: "VESPER (RADIO)", text: "Something's on the hoist. Nobody comes up the hoist.", seconds: 4 },
        { who: "VESPER (RADIO)", text: "It's him. Take him at the top. Alive, if you can manage it.", seconds: 4.5 },
    ],
    rimFight: [{ who: "VESPER (RADIO)", text: "Pull back! Pull back! Let the canyon have him.", seconds: 4 }],
    outro2: [
        { who: "RAY", text: "Doctor, if you can hear this. I'm coming.", seconds: 4 },
        { who: "", text: "Above Noctis, the capital burns quietly in the dark.", seconds: 4.5 },
        { who: "", text: "Somewhere past the static, someone is still talking.", seconds: 4.5 },
    ],
};

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
    ...LINES2,
};
