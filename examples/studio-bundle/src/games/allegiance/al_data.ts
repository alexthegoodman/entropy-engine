// Allegiance's static data: the world of 2100 (its power blocs and the regions every square meter
// of Earth belongs to), the factions competing for it, the ideologies you can found a party on,
// what people care about (speech topics, audience segments) and everything you can buy (weapons,
// armor, facilities), learn (skills) or plot (schemes).
//
// Everything here is plain data; the rules that use it live in al_world.ts, al_party.ts,
// al_speech.ts and al_combat.ts.

// --- Topics --------------------------------------------------------------------------------------

export type TopicId = "jobs" | "security" | "liberty" | "climate" | "equality" | "tradition" | "progress" | "corruption";

export const TOPICS: { id: TopicId; name: string; blurb: string }[] = [
    { id: "jobs", name: "Jobs", blurb: "Automation took the work. Who gives it back?" },
    { id: "security", name: "Security", blurb: "Order on the streets, borders that hold." },
    { id: "liberty", name: "Liberty", blurb: "Out from under the Concordat's sensors." },
    { id: "climate", name: "Climate", blurb: "The seas rose; the cities must rise faster." },
    { id: "equality", name: "Equality", blurb: "The towers and the flooded quarters." },
    { id: "tradition", name: "Tradition", blurb: "Faith, family, the old ways." },
    { id: "progress", name: "Progress", blurb: "Fusion, orbitals, the next century." },
    { id: "corruption", name: "Corruption", blurb: "The Concordat's ministers grow fat." },
];

export const TOPIC_IDS: TopicId[] = TOPICS.map(t => t.id);
export type TopicWeights = Record<TopicId, number>;

const tw = (jobs: number, security: number, liberty: number, climate: number, equality: number, tradition: number, progress: number, corruption: number): TopicWeights =>
    ({ jobs, security, liberty, climate, equality, tradition, progress, corruption });

// --- Blocs ---------------------------------------------------------------------------------------

export type GovType = "democracy" | "technocracy" | "junta" | "oligarchy";

export interface BlocDef {
    id: string;
    name: string;
    short: string;
    /** What the people here care about, 0..1. */
    topics: TopicWeights;
    /** The government most of its regions start with. */
    gov: GovType;
    /** How hard its military hits back (troops per million people, and quality 0..1). */
    militaryPerMillion: number;
    quality: number;
}

export const BLOCS: BlocDef[] = [
    { id: "nac", name: "North American Compact", short: "NAC", topics: tw(0.8, 0.6, 0.9, 0.4, 0.5, 0.5, 0.7, 0.7), gov: "democracy", militaryPerMillion: 120, quality: 0.85 },
    { id: "latin", name: "Latin Federation", short: "LATFED", topics: tw(0.9, 0.7, 0.5, 0.6, 0.8, 0.6, 0.4, 0.9), gov: "democracy", militaryPerMillion: 60, quality: 0.55 },
    { id: "euro", name: "Euro Federation", short: "EUROFED", topics: tw(0.6, 0.5, 0.7, 0.9, 0.7, 0.4, 0.6, 0.5), gov: "technocracy", militaryPerMillion: 70, quality: 0.8 },
    { id: "eurasia", name: "Eurasian Concord", short: "EURCON", topics: tw(0.7, 0.9, 0.3, 0.3, 0.4, 0.8, 0.5, 0.8), gov: "junta", militaryPerMillion: 160, quality: 0.75 },
    { id: "gulf", name: "Gulf-Levant Assembly", short: "GLA", topics: tw(0.8, 0.8, 0.4, 0.7, 0.5, 0.9, 0.6, 0.7), gov: "oligarchy", militaryPerMillion: 110, quality: 0.7 },
    { id: "africa", name: "Pan-African Union", short: "PAU", topics: tw(1.0, 0.6, 0.6, 0.8, 0.9, 0.6, 0.7, 0.8), gov: "democracy", militaryPerMillion: 40, quality: 0.5 },
    { id: "sino", name: "Sinosphere Directorate", short: "SINODIR", topics: tw(0.7, 0.8, 0.3, 0.6, 0.5, 0.6, 0.9, 0.6), gov: "technocracy", militaryPerMillion: 90, quality: 0.85 },
    { id: "indopac", name: "Indo-Pacific Concord", short: "IPC", topics: tw(0.9, 0.6, 0.6, 0.9, 0.8, 0.7, 0.8, 0.7), gov: "democracy", militaryPerMillion: 55, quality: 0.65 },
];

export const blocById = (id: string): BlocDef => BLOCS.find(b => b.id === id) ?? BLOCS[0];

// --- Regions -------------------------------------------------------------------------------------

/**
 * A region: a great city of 2100 and its hinterland. Every point on Earth belongs to the region
 * whose city is nearest (along the surface), so the regions tile the whole planet.
 */
export interface RegionDef {
    id: string;
    name: string;
    country: string;
    lat: number;
    lon: number;
    /** People in millions (city and hinterland). */
    pop: number;
    bloc: string;
    /** Income per head relative to the world average (taxes, party dues). */
    wealth: number;
    /** Overrides the bloc's government type. */
    gov?: GovType;
    /** Local settlement carved out of a surrounding territory. */
    parent?: string;
    kind?: string;
    radiusKm?: number;
}

const R = (name: string, country: string, lat: number, lon: number, pop: number, bloc: string, wealth: number, gov?: GovType): RegionDef => ({
    id: name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    name, country, lat, lon, pop, bloc, wealth, gov,
});

export const REGIONS: RegionDef[] = [
    // North American Compact
    R("New York", "USA", 40.7128, -74.006, 95, "nac", 1.8),
    R("Los Angeles", "USA", 34.0522, -118.2437, 70, "nac", 1.7),
    R("Chicago", "USA", 41.8781, -87.6298, 50, "nac", 1.6),
    R("Houston", "USA", 29.7604, -95.3698, 55, "nac", 1.6),
    R("Atlanta", "USA", 33.749, -84.388, 45, "nac", 1.5),
    R("Miami", "USA", 25.7617, -80.1918, 30, "nac", 1.4),
    R("Seattle", "USA", 47.6062, -122.3321, 35, "nac", 1.8),
    R("Denver", "USA", 39.7392, -104.9903, 30, "nac", 1.5),
    R("Washington", "USA", 38.9072, -77.0369, 40, "nac", 1.9),
    R("Toronto", "Canada", 43.6532, -79.3832, 45, "nac", 1.6),
    R("Montreal", "Canada", 45.5017, -73.5673, 25, "nac", 1.4),
    R("Vancouver", "Canada", 49.2827, -123.1207, 25, "nac", 1.6),
    R("Mexico City", "Mexico", 19.4326, -99.1332, 110, "nac", 0.8),
    R("Monterrey", "Mexico", 25.6866, -100.3161, 45, "nac", 0.9),
    R("Guadalajara", "Mexico", 20.6597, -103.3496, 40, "nac", 0.8),
    // Latin Federation
    R("Guatemala City", "Guatemala", 14.6349, -90.5069, 40, "latin", 0.5),
    R("Havana", "Cuba", 23.1136, -82.3666, 20, "latin", 0.5, "junta"),
    R("Bogota", "Colombia", 4.711, -74.0721, 75, "latin", 0.7),
    R("Caracas", "Venezuela", 10.4806, -66.9036, 40, "latin", 0.5, "junta"),
    R("Lima", "Peru", -12.0464, -77.0428, 60, "latin", 0.7),
    R("Quito", "Ecuador", -0.1807, -78.4678, 30, "latin", 0.6),
    R("Sao Paulo", "Brazil", -23.5505, -46.6333, 110, "latin", 0.9),
    R("Rio de Janeiro", "Brazil", -22.9068, -43.1729, 70, "latin", 0.8),
    R("Brasilia", "Brazil", -15.8267, -47.9218, 40, "latin", 0.9),
    R("Manaus", "Brazil", -3.119, -60.0217, 25, "latin", 0.5),
    R("Recife", "Brazil", -8.0476, -34.877, 50, "latin", 0.6),
    R("Buenos Aires", "Argentina", -34.6037, -58.3816, 70, "latin", 0.9),
    R("Santiago", "Chile", -33.4489, -70.6693, 40, "latin", 1.0),
    R("La Paz", "Bolivia", -16.4897, -68.1193, 30, "latin", 0.5),
    // Euro Federation
    R("London", "Britain", 51.5074, -0.1278, 70, "euro", 1.7, "democracy"),
    R("Paris", "France", 48.8566, 2.3522, 70, "euro", 1.7),
    R("Berlin", "Germany", 52.52, 13.405, 55, "euro", 1.7),
    R("Madrid", "Spain", 40.4168, -3.7038, 50, "euro", 1.4),
    R("Rome", "Italy", 41.9028, 12.4964, 45, "euro", 1.4),
    R("Warsaw", "Poland", 52.2297, 21.0122, 35, "euro", 1.3),
    R("Stockholm", "Sweden", 59.3293, 18.0686, 25, "euro", 1.8),
    R("Amsterdam", "Netherlands", 52.3676, 4.9041, 35, "euro", 1.8),
    R("Athens", "Greece", 37.9838, 23.7275, 20, "euro", 1.1),
    R("Kyiv", "Ukraine", 50.4501, 30.5234, 30, "euro", 1.0, "democracy"),
    R("Lisbon", "Portugal", 38.7223, -9.1393, 20, "euro", 1.2),
    R("Vienna", "Austria", 48.2082, 16.3738, 25, "euro", 1.7),
    R("Dublin", "Ireland", 53.3498, -6.2603, 15, "euro", 1.8, "democracy"),
    // Eurasian Concord
    R("Moscow", "Russia", 55.7558, 37.6173, 60, "eurasia", 1.1),
    R("Saint Petersburg", "Russia", 59.9311, 30.3609, 25, "eurasia", 1.0),
    R("Novosibirsk", "Russia", 55.0084, 82.9357, 20, "eurasia", 0.8),
    R("Almaty", "Kazakhstan", 43.222, 76.8512, 25, "eurasia", 0.9),
    R("Tashkent", "Uzbekistan", 41.2995, 69.2401, 45, "eurasia", 0.6),
    R("Vladivostok", "Russia", 43.1155, 131.8855, 10, "eurasia", 0.9),
    // Gulf-Levant Assembly
    R("Istanbul", "Turkey", 41.0082, 28.9784, 90, "gulf", 1.0, "democracy"),
    R("Cairo", "Egypt", 30.0444, 31.2357, 130, "gulf", 0.5, "junta"),
    R("Riyadh", "Arabia", 24.7136, 46.6753, 45, "gulf", 1.3),
    R("Dubai", "Emirates", 25.2048, 55.2708, 30, "gulf", 1.6),
    R("Tehran", "Iran", 35.6892, 51.389, 70, "gulf", 0.7),
    R("Baghdad", "Iraq", 33.3152, 44.3661, 65, "gulf", 0.6),
    R("Tel Aviv", "Israel", 32.0853, 34.7818, 20, "gulf", 1.5, "democracy"),
    R("Amman", "Jordan", 31.9454, 35.9284, 25, "gulf", 0.7),
    R("Kabul", "Afghanistan", 34.5553, 69.2075, 70, "gulf", 0.3, "junta"),
    // Pan-African Union
    R("Lagos", "Nigeria", 6.5244, 3.3792, 210, "africa", 0.45),
    R("Kinshasa", "Congo", -4.4419, 15.2663, 190, "africa", 0.25),
    R("Dar es Salaam", "Tanzania", -6.7924, 39.2083, 150, "africa", 0.3),
    R("Nairobi", "Kenya", -1.2921, 36.8219, 110, "africa", 0.45),
    R("Addis Ababa", "Ethiopia", 9.03, 38.74, 130, "africa", 0.35),
    R("Khartoum", "Sudan", 15.5007, 32.5599, 110, "africa", 0.3, "junta"),
    R("Niamey", "Niger", 13.5116, 2.1254, 100, "africa", 0.2, "junta"),
    R("Luanda", "Angola", -8.839, 13.2894, 90, "africa", 0.4, "oligarchy"),
    R("Johannesburg", "South Africa", -26.2041, 28.0473, 80, "africa", 0.8),
    R("Cape Town", "South Africa", -33.9249, 18.4241, 30, "africa", 0.8),
    R("Accra", "Ghana", 5.6037, -0.187, 70, "africa", 0.5),
    R("Dakar", "Senegal", 14.7167, -17.4677, 50, "africa", 0.4),
    R("Abidjan", "Ivory Coast", 5.36, -4.0083, 70, "africa", 0.45),
    R("Kampala", "Uganda", 0.3476, 32.5825, 95, "africa", 0.3, "oligarchy"),
    R("Algiers", "Algeria", 36.7538, 3.0588, 50, "africa", 0.6, "junta"),
    R("Casablanca", "Morocco", 33.5731, -7.5898, 45, "africa", 0.6, "oligarchy"),
    R("Lusaka", "Zambia", -15.3875, 28.3228, 70, "africa", 0.35),
    R("Mogadishu", "Somalia", 2.0469, 45.3182, 70, "africa", 0.2, "junta"),
    R("Antananarivo", "Madagascar", -18.8792, 47.5079, 50, "africa", 0.25),
    // Sinosphere Directorate
    R("Beijing", "China", 39.9042, 116.4074, 110, "sino", 1.1),
    R("Shanghai", "China", 31.2304, 121.4737, 120, "sino", 1.3),
    R("Guangzhou", "China", 23.1291, 113.2644, 120, "sino", 1.1),
    R("Chongqing", "China", 29.4316, 106.9123, 90, "sino", 0.9),
    R("Wuhan", "China", 30.5928, 114.3055, 70, "sino", 1.0),
    R("Chengdu", "China", 30.5728, 104.0668, 70, "sino", 0.9),
    R("Hong Kong", "China", 22.3193, 114.1694, 30, "sino", 1.6),
    R("Seoul", "Korea", 37.5665, 126.978, 40, "sino", 1.5, "democracy"),
    R("Tokyo", "Japan", 35.6762, 139.6503, 80, "sino", 1.6, "democracy"),
    R("Osaka", "Japan", 34.6937, 135.5023, 40, "sino", 1.5, "democracy"),
    R("Taipei", "Taiwan", 25.033, 121.5654, 25, "sino", 1.5, "democracy"),
    R("Ulaanbaatar", "Mongolia", 47.8864, 106.9057, 5, "sino", 0.6, "oligarchy"),
    // Indo-Pacific Concord
    R("Delhi", "India", 28.6139, 77.209, 200, "indopac", 0.6),
    R("Mumbai", "India", 19.076, 72.8777, 190, "indopac", 0.7),
    R("Kolkata", "India", 22.5726, 88.3639, 150, "indopac", 0.5),
    R("Bengaluru", "India", 12.9716, 77.5946, 120, "indopac", 0.8),
    R("Chennai", "India", 13.0827, 80.2707, 90, "indopac", 0.6),
    R("Dhaka", "Bangladesh", 23.8103, 90.4125, 180, "indopac", 0.4),
    R("Karachi", "Pakistan", 24.8607, 67.0011, 110, "indopac", 0.4, "junta"),
    R("Lahore", "Pakistan", 31.5204, 74.3587, 110, "indopac", 0.4, "junta"),
    R("Jakarta", "Indonesia", -6.2088, 106.8456, 160, "indopac", 0.7),
    R("Manila", "Philippines", 14.5995, 120.9842, 130, "indopac", 0.6),
    R("Bangkok", "Thailand", 13.7563, 100.5018, 70, "indopac", 0.8, "junta"),
    R("Ho Chi Minh City", "Vietnam", 10.8231, 106.6297, 70, "indopac", 0.7, "technocracy"),
    R("Hanoi", "Vietnam", 21.0285, 105.8542, 50, "indopac", 0.6, "technocracy"),
    R("Singapore", "Singapore", 1.3521, 103.8198, 15, "indopac", 1.9, "technocracy"),
    R("Kuala Lumpur", "Malaysia", 3.139, 101.6869, 40, "indopac", 1.1),
    R("Yangon", "Myanmar", 16.8409, 96.1735, 50, "indopac", 0.35, "junta"),
    R("Sydney", "Australia", -33.8688, 151.2093, 25, "indopac", 1.6),
    R("Melbourne", "Australia", -37.8136, 144.9631, 25, "indopac", 1.6),
    R("Perth", "Australia", -31.9505, 115.8605, 10, "indopac", 1.5),
    R("Auckland", "New Zealand", -36.8485, 174.7633, 8, "indopac", 1.5),
];

export interface CountryDef { name: string; ideology: string; ruler: string }
export const COUNTRIES: CountryDef[] = [
    { name: "New America", ideology: "liberty", ruler: "current" },
    { name: "The Workers States of America", ideology: "solidarity", ruler: "verdant" },
    ...BLOCS.map(b => ({ name: b.name, ideology: b.gov === "junta" ? "order" : b.gov === "technocracy" ? "ascendancy" : "solidarity", ruler: b.gov === "junta" ? "vanguard" : "concordat" })),
];
// The old country labels are geographic provenance only; sovereign territories belong to 2100 states.
for (const r of REGIONS) r.country = r.country === "USA"
    ? (r.lon < -100 ? "New America" : "The Workers States of America") : blocById(r.bloc).name;
export const countryOf = (r: RegionDef): CountryDef => COUNTRIES.find(c => c.name === r.country) ?? COUNTRIES[0];
const settlementDefs = new Map<string, RegionDef>();
export function registerSettlement(def: RegionDef): void { settlementDefs.set(def.id, def); }

export const WORLD_POPULATION = REGIONS.reduce((s, r) => s + r.pop, 0);

export const regionDefById = (id: string): RegionDef | undefined => REGIONS.find(r => r.id === id) ?? settlementDefs.get(id);

// --- Factions ------------------------------------------------------------------------------------

export type RGBA = [number, number, number, number];

export interface FactionDef {
    id: string;
    name: string;
    short: string;
    color: RGBA;
    /** What they campaign on. */
    topics: TopicId[];
    /** How hard they push (support gained per day while campaigning). */
    drive: number;
    motto: string;
}

/** "party" is you; the rest are run by the AI. The Concordat governs most of the world at start. */
export const PARTY = "party";
export const UNDECIDED = "undecided";

export const FACTIONS: FactionDef[] = [
    { id: PARTY, name: "Your Party", short: "PARTY", color: [0.85, 0.08, 0.12, 1], topics: [], drive: 0, motto: "" },
    { id: "concordat", name: "The Concordat", short: "CONCORDAT", color: [0.35, 0.55, 0.85, 1], topics: ["security", "progress", "climate"], drive: 0.006, motto: "Stability is Peace." },
    { id: "vanguard", name: "Iron Vanguard", short: "VANGUARD", color: [0.45, 0.47, 0.3, 1], topics: ["security", "tradition", "jobs"], drive: 0.009, motto: "Strength. Blood. Soil." },
    { id: "verdant", name: "Verdant Accord", short: "VERDANT", color: [0.25, 0.75, 0.4, 1], topics: ["climate", "equality", "progress"], drive: 0.008, motto: "The Earth Remembers." },
    { id: "current", name: "Free Current", short: "CURRENT", color: [0.95, 0.75, 0.15, 1], topics: ["liberty", "corruption", "jobs"], drive: 0.008, motto: "Unplug the State." },
];

export const RIVALS = FACTIONS.filter(f => f.id !== PARTY).map(f => f.id);
export const factionById = (id: string): FactionDef => FACTIONS.find(f => f.id === id) ?? FACTIONS[1];

// --- Ideologies ----------------------------------------------------------------------------------

export interface IdeologyDef {
    id: string;
    name: string;
    slogan: string;
    /** Speech topics you are strongest on (x1.35) and weakest on (x0.75). */
    strong: TopicId[];
    weak: TopicId[];
    color: RGBA;
    blurb: string;
}

export const IDEOLOGIES: IdeologyDef[] = [
    { id: "solidarity", name: "Solidarity", slogan: "ONE PEOPLE. ONE BREAD.", strong: ["equality", "jobs"], weak: ["liberty"], color: [0.85, 0.08, 0.12, 1], blurb: "Workers of the drowned districts, unite. Bread, work and dignity for all." },
    { id: "order", name: "Order", slogan: "DISCIPLINE IS FREEDOM.", strong: ["security", "tradition"], weak: ["equality"], color: [0.12, 0.12, 0.14, 1], blurb: "The century of chaos ends with us. Law, duty, and the strong hand." },
    { id: "liberty", name: "Liberty", slogan: "BREAK THE SENSORS.", strong: ["liberty", "corruption"], weak: ["security"], color: [0.95, 0.55, 0.05, 1], blurb: "Tear down the surveillance state and the ministers who feed on it." },
    { id: "ascendancy", name: "Ascendancy", slogan: "TOMORROW BELONGS TO US.", strong: ["progress", "climate"], weak: ["tradition"], color: [0.1, 0.45, 0.85, 1], blurb: "Reactors, sea walls, orbital forges. Humanity must climb or drown." },
];

export const ideologyById = (id: string): IdeologyDef => IDEOLOGIES.find(i => i.id === id) ?? IDEOLOGIES[0];

/** Party colors the player can pick for armbands, banners and the map. */
export const PARTY_COLORS: { name: string; color: RGBA }[] = [
    { name: "Crimson", color: [0.85, 0.08, 0.12, 1] },
    { name: "Black", color: [0.1, 0.1, 0.11, 1] },
    { name: "Orange", color: [0.95, 0.5, 0.05, 1] },
    { name: "Cobalt", color: [0.1, 0.4, 0.9, 1] },
    { name: "Violet", color: [0.55, 0.15, 0.75, 1] },
    { name: "White", color: [0.92, 0.9, 0.84, 1] },
];

// --- Audiences -----------------------------------------------------------------------------------

export type Tone = "hope" | "anger" | "fear";

export interface SegmentDef {
    id: string;
    name: string;
    topics: TopicWeights;
    /** How each tone lands with them (multiplier). */
    tones: Record<Tone, number>;
}

export const SEGMENTS: SegmentDef[] = [
    { id: "workers", name: "Workers", topics: tw(1, 0.5, 0.4, 0.4, 0.9, 0.5, 0.3, 0.7), tones: { hope: 1.0, anger: 1.25, fear: 0.8 } },
    { id: "students", name: "Students", topics: tw(0.5, 0.2, 1, 0.9, 0.8, 0.1, 0.8, 0.7), tones: { hope: 1.25, anger: 1.1, fear: 0.6 } },
    { id: "professionals", name: "Professionals", topics: tw(0.5, 0.6, 0.6, 0.6, 0.3, 0.3, 1, 0.6), tones: { hope: 1.15, anger: 0.7, fear: 0.9 } },
    { id: "elders", name: "Elders", topics: tw(0.4, 1, 0.3, 0.3, 0.4, 1, 0.2, 0.5), tones: { hope: 0.9, anger: 0.8, fear: 1.3 } },
    { id: "faithful", name: "Faithful", topics: tw(0.6, 0.6, 0.3, 0.4, 0.6, 1, 0.2, 0.8), tones: { hope: 1.1, anger: 0.9, fear: 1.1 } },
    { id: "veterans", name: "Veterans", topics: tw(0.7, 1, 0.5, 0.2, 0.4, 0.7, 0.4, 0.9), tones: { hope: 0.9, anger: 1.2, fear: 1.0 } },
];

// --- Speech cards --------------------------------------------------------------------------------

export interface SpeechCard {
    id: string;
    topic: TopicId;
    tone: Tone;
    title: string;
    line: string;
    /** Base persuasive power. */
    power: number;
    /** Karma per delivery (hope +, fear -). */
    karma: number;
    /** Oratory level needed before it can be drawn. */
    oratory: number;
}

const C = (id: string, topic: TopicId, tone: Tone, title: string, line: string, power: number, oratory = 0): SpeechCard =>
    ({ id, topic, tone, title, line, power, karma: tone === "hope" ? 1 : tone === "fear" ? -2 : 0, oratory });

export const SPEECH_CARDS: SpeechCard[] = [
    C("jobs-h1", "jobs", "hope", "Hands Again", "Every idle hand will build the new century!", 1.0),
    C("jobs-a1", "jobs", "anger", "Machines Took Your Bread", "They replaced you with a subscription and called it progress!", 1.1),
    C("jobs-f1", "jobs", "fear", "Next Year, Your Job", "If you still work, you are next. Ask your neighbors.", 1.0),
    C("jobs-h2", "jobs", "hope", "The Guarantee", "A wage for every citizen, written into law on our first day.", 1.4, 2),
    C("sec-h1", "security", "hope", "Safe Streets", "Children should walk home without a drone escort.", 1.0),
    C("sec-a1", "security", "anger", "They Abandoned You", "The Concordat guards its towers and leaves you the floodwater.", 1.1),
    C("sec-f1", "security", "fear", "The Gangs Are Coming", "Lock your doors. The chaos is already in the next district.", 1.15),
    C("sec-f2", "security", "fear", "Enemies Within", "There are traitors in this very crowd. We will find them.", 1.5, 3),
    C("lib-h1", "liberty", "hope", "Unplugged", "Imagine a day without a sensor on your shoulder.", 1.0),
    C("lib-a1", "liberty", "anger", "They Read Your Dreams", "Every word you say tonight is already on a Concordat server!", 1.1),
    C("lib-h2", "liberty", "hope", "The Free Republic", "We will burn the watchlists in this very square.", 1.45, 2),
    C("cli-h1", "climate", "hope", "Rise With The Sea", "We will build walls taller than their excuses.", 1.0),
    C("cli-a1", "climate", "anger", "They Sold The Coast", "They knew in 2030. They knew in 2060. They sold your home anyway.", 1.1),
    C("cli-f1", "climate", "fear", "Next Storm", "One more storm and this square is underwater.", 1.05),
    C("eq-h1", "equality", "hope", "One People", "No towers, no floodlands. One city, one people.", 1.0),
    C("eq-a1", "equality", "anger", "The Tower Lords", "They eat oranges flown from orbit while you queue for algae!", 1.15),
    C("eq-h2", "equality", "hope", "Share The Sky", "Every family a home above the waterline.", 1.45, 2),
    C("tra-h1", "tradition", "hope", "Our Fathers' Ways", "Remember who we were before the screens.", 1.0),
    C("tra-f1", "tradition", "fear", "They Will Erase You", "Your faith, your tongue, your name: all deleted by decree.", 1.15),
    C("tra-a1", "tradition", "anger", "Rootless Rulers", "Men with no country tell you how to pray!", 1.1),
    C("pro-h1", "progress", "hope", "Fusion For All", "Free power from the sun we caged. Free for every home.", 1.0),
    C("pro-h2", "progress", "hope", "To The Orbitals", "Your children will be born among the stars.", 1.4, 2),
    C("pro-a1", "progress", "anger", "They Hoard Tomorrow", "The future exists. They just keep it for themselves.", 1.1),
    C("cor-a1", "corruption", "anger", "Fat Ministers", "Name one minister who drowned in the floods. You can't!", 1.15),
    C("cor-h1", "corruption", "hope", "Clean Hands", "Every party official will live as you live. Audited, open, honest.", 1.0),
    C("cor-f1", "corruption", "fear", "The Ledger", "We have their files. Soon, so will you.", 1.1, 1),
    C("all-h3", "equality", "hope", "The Great Promise", "Together we will take this planet back - for everyone!", 1.8, 4),
    C("all-f3", "security", "fear", "The Final Purge", "When we rule, the weak and the treacherous will vanish.", 2.0, 4),
];

// --- Gear ----------------------------------------------------------------------------------------

export interface WeaponDef {
    id: string;
    name: string;
    damage: number;
    /** Shots per second. */
    rate: number;
    /** Cone half-angle in radians. */
    spread: number;
    range: number;
    magazine: number;
    reload: number;
    /** Pellets per shot (shotgun). */
    pellets: number;
    auto: boolean;
    price: number;
    color: [number, number, number];
    blurb: string;
}

export const WEAPONS: WeaponDef[] = [
    { id: "fists", name: "Bare Fists", damage: 12, rate: 2, spread: 0.05, range: 2.2, magazine: Infinity, reload: 0, pellets: 1, auto: false, price: 0, color: [0.8, 0.6, 0.5], blurb: "Persuasion of last resort." },
    { id: "pistol", name: "M-90 Sidearm", damage: 22, rate: 3, spread: 0.02, range: 70, magazine: 12, reload: 1.3, pellets: 1, auto: false, price: 400, color: [0.2, 0.2, 0.22], blurb: "Reliable, quiet, legal-ish." },
    { id: "smg", name: "Kestrel SMG", damage: 15, rate: 11, spread: 0.05, range: 55, magazine: 32, reload: 1.8, pellets: 1, auto: true, price: 1400, color: [0.25, 0.25, 0.28], blurb: "Spray and pray." },
    { id: "shotgun", name: "Breacher 12", damage: 13, rate: 1.3, spread: 0.09, range: 25, magazine: 6, reload: 2.4, pellets: 8, auto: false, price: 1100, color: [0.35, 0.22, 0.12], blurb: "Ends arguments at the door." },
    { id: "rifle", name: "AR-2100 Rifle", damage: 30, rate: 7, spread: 0.018, range: 160, magazine: 30, reload: 2.1, pellets: 1, auto: true, price: 3200, color: [0.18, 0.2, 0.16], blurb: "The workhorse of every revolution." },
    { id: "marksman", name: "Longshot DMR", damage: 75, rate: 1.4, spread: 0.004, range: 320, magazine: 10, reload: 2.6, pellets: 1, auto: false, price: 5200, color: [0.15, 0.15, 0.12], blurb: "One shot, one argument." },
    { id: "rail", name: "Voltaic Railgun", damage: 160, rate: 0.7, spread: 0.002, range: 500, magazine: 5, reload: 3.2, pellets: 1, auto: false, price: 14000, color: [0.3, 0.75, 1.0], blurb: "Concordat military tech. Goes through walls of excuses." },
];

export interface ArmorDef { id: string; name: string; armor: number; absorb: number; price: number; blurb: string }

export const ARMORS: ArmorDef[] = [
    { id: "none", name: "Street Clothes", armor: 0, absorb: 0, price: 0, blurb: "Nothing between you and history." },
    { id: "vest", name: "Kevlar Vest", armor: 50, absorb: 0.4, price: 900, blurb: "Stops a pistol round. Usually." },
    { id: "plate", name: "Ceramic Plates", armor: 100, absorb: 0.55, price: 2800, blurb: "Heavy, ugly, alive." },
    { id: "exo", name: "Exo-Frame", armor: 200, absorb: 0.7, price: 9000, blurb: "Powered armor stolen from a Concordat depot." },
];

export const weaponById = (id: string): WeaponDef => WEAPONS.find(w => w.id === id) ?? WEAPONS[0];
export const armorById = (id: string): ArmorDef => ARMORS.find(a => a.id === id) ?? ARMORS[0];

// --- Skills --------------------------------------------------------------------------------------

export type SkillId = "oratory" | "persuasion" | "leadership" | "marksmanship" | "toughness" | "intrigue";

export const SKILLS: { id: SkillId; name: string; blurb: string }[] = [
    { id: "oratory", name: "Oratory", blurb: "Wider timing window, stronger cards, louder voice." },
    { id: "persuasion", name: "Persuasion", blurb: "Pamphlets and one-to-one talks convert more." },
    { id: "leadership", name: "Leadership", blurb: "Command more officers directly; followers fight harder." },
    { id: "marksmanship", name: "Marksmanship", blurb: "Tighter spread, more damage." },
    { id: "toughness", name: "Toughness", blurb: "More health, faster recovery." },
    { id: "intrigue", name: "Intrigue", blurb: "Schemes succeed more often and cost less." },
];

export const SKILL_MAX = 5;
/** Skill points to raise a skill from level n to n+1. */
export const skillCost = (level: number): number => level + 1;

// --- Facilities ----------------------------------------------------------------------------------

export interface FacilityDef { id: string; name: string; price: number; upkeep: number; blurb: string }

export const FACILITIES: FacilityDef[] = [
    { id: "press", name: "Printing Press", price: 2500, upkeep: 40, blurb: "Pamphlets cost half and convince more." },
    { id: "radio", name: "Pirate Broadcast", price: 8000, upkeep: 150, blurb: "Daily support gain in every region you have a presence in." },
    { id: "camp", name: "Training Camp", price: 12000, upkeep: 250, blurb: "Your armed forces fight 30% better." },
    { id: "safehouses", name: "Safehouse Network", price: 6000, upkeep: 100, blurb: "Crackdowns and failed schemes cost far fewer members." },
    { id: "bank", name: "Party Bank", price: 15000, upkeep: 0, blurb: "+15% to all dues and taxes collected." },
];

// --- Schemes -------------------------------------------------------------------------------------

export type SchemeEffect =
    | "support"      // party support in the region
    | "rival-down"   // the strongest rival's support in the region
    | "funds"        // money
    | "members"      // members in the region
    | "security-down"// the regime's garrison in the region
    | "unrest";      // unrest (helps revolutions and coups)

export interface SchemeDef {
    id: string;
    name: string;
    blurb: string;
    cost: number;
    days: number;
    chance: number;
    karma: number;
    effect: SchemeEffect;
    amount: number;
}

export const SCHEMES: SchemeDef[] = [
    { id: "charity", name: "Charity Drive", blurb: "Soup, shelter and leaflets. The people remember kindness.", cost: 1500, days: 3, chance: 0.95, karma: 6, effect: "support", amount: 0.05 },
    { id: "strike", name: "Organize a Strike", blurb: "Shut the docks and the server farms until they listen.", cost: 2000, days: 4, chance: 0.75, karma: 2, effect: "unrest", amount: 0.2 },
    { id: "broadcast", name: "Hijack the Feeds", blurb: "Your face on every screen in the region for one glorious hour.", cost: 3000, days: 2, chance: 0.7, karma: 0, effect: "support", amount: 0.07 },
    { id: "bribe", name: "Bribe Officials", blurb: "Grease the right palms in the regional ministry.", cost: 4000, days: 2, chance: 0.8, karma: -4, effect: "security-down", amount: 0.25 },
    { id: "smear", name: "Smear Campaign", blurb: "Leak the rival leader's private messages. Real or not.", cost: 2500, days: 3, chance: 0.7, karma: -6, effect: "rival-down", amount: 0.08 },
    { id: "extort", name: "Shake Down Merchants", blurb: "Protection money. For the cause.", cost: 0, days: 2, chance: 0.8, karma: -8, effect: "funds", amount: 6000 },
    { id: "infiltrate", name: "Infiltrate Unions", blurb: "Plant organizers in every guild hall.", cost: 3500, days: 5, chance: 0.75, karma: -1, effect: "members", amount: 0.004 },
    { id: "assassinate", name: "Assassinate a Rival", blurb: "A tragic accident befalls the rival's regional chief.", cost: 8000, days: 4, chance: 0.55, karma: -20, effect: "rival-down", amount: 0.2 },
    { id: "fundraise", name: "Gala Fundraiser", blurb: "Sympathetic tower lords open their wallets.", cost: 800, days: 3, chance: 0.85, karma: 1, effect: "funds", amount: 4000 },
];

export const schemeById = (id: string): SchemeDef | undefined => SCHEMES.find(s => s.id === id);

// --- Pamphlets -----------------------------------------------------------------------------------

export interface PamphletDef { id: string; name: string; price: number; opinion: number; karma: number; rivalHit: number; blurb: string }

export const PAMPHLETS: PamphletDef[] = [
    { id: "truth", name: "The Plain Truth", price: 6, opinion: 0.12, karma: 0.3, rivalHit: 0, blurb: "Honest facts. Slow, but they stick." },
    { id: "propaganda", name: "Glorious Tomorrow", price: 4, opinion: 0.18, karma: 0, rivalHit: 0, blurb: "Bold promises, bright colors." },
    { id: "smear", name: "What They Hide", price: 5, opinion: 0.08, karma: -0.6, rivalHit: 0.15, blurb: "Lies about the rivals. Effective lies." },
];

export const pamphletById = (id: string): PamphletDef => PAMPHLETS.find(p => p.id === id) ?? PAMPHLETS[0];

// --- Names ---------------------------------------------------------------------------------------

export const FIRST_NAMES = [
    "Amara", "Kofi", "Ines", "Mateo", "Yuki", "Ravi", "Leila", "Sven", "Chen", "Ngozi", "Dmitri", "Ana", "Tariq", "Mei", "Oluwa", "Lucia",
    "Hassan", "Priya", "Jonas", "Zara", "Kwame", "Sofia", "Arjun", "Elena", "Bao", "Fatima", "Diego", "Hana", "Malik", "Ingrid", "Tomas",
    "Aiko", "Omar", "Nadia", "Rafael", "Sun", "Zainab", "Viktor", "Imani", "Pedro", "Lin", "Esi", "Marek", "Ayasha", "Kenji", "Farah",
    "Juno", "Idris", "Mira", "Caio", "Thandi", "Ilya", "Rosa", "Dev", "Noor", "Emeka", "Freya", "Hiro", "Lola", "Aziz", "Vera",
];

export const LAST_NAMES = [
    "Okafor", "Silva", "Tanaka", "Kowalski", "Mensah", "Haddad", "Novak", "Reyes", "Zhang", "Ivanova", "Singh", "Adeyemi", "Moreau",
    "Kim", "Nguyen", "Hassan", "Petrov", "Banda", "Rossi", "Sato", "Abebe", "Lindqvist", "Castillo", "Mwangi", "Fischer", "Rahman",
    "Osei", "Park", "Quispe", "Diallo", "Weber", "Costa", "Yilmaz", "Chowdhury", "Okonkwo", "Morales", "Wójcik", "Kato", "Nakamura",
    "Achebe", "Sokolov", "Mendes", "Farouk", "Lund", "Bello", "Ortega", "Ito", "Kaur", "Ndlovu", "Varga", "Haile", "Duarte",
];
