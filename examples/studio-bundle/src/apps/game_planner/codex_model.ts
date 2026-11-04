import type { CodexCategory, CodexEntry, GenreType, WorldSpot } from "./planner_types";

export function createCodexEntry(
    name: string,
    category: CodexCategory,
    subtitle: string,
    description: string,
    genre: GenreType = "fantasy"
): CodexEntry {
    const id = `codex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const prompt = generateConceptImagePrompt(name, category, subtitle, description, genre);

    return {
        id,
        name,
        category,
        subtitle,
        description,
        attributes: defaultAttributesForCategory(category),
        tags: [category],
        linkedSpotIds: [],
        linkedMissionIds: [],
        conceptImagePrompt: prompt,
    };
}

function defaultAttributesForCategory(category: CodexCategory): Record<string, string | number> {
    switch (category) {
        case "character":
            return {
                Role: "NPC",
                Affiliation: "Unaligned",
                Level: 15,
                Archetype: "Warrior",
                Morality: "Neutral Good",
            };
        case "power":
            return {
                School: "Elemental",
                Rank: "Tier 3",
                ManaCost: 65,
                CastTime: "1.5s",
                Range: "25m",
            };
        case "weapon":
            return {
                Type: "Greatsword",
                Rarity: "Legendary",
                Damage: "140-185",
                Weight: "4.5 kg",
                Attunement: "Yes",
            };
        case "faction":
            return {
                Leader: "Unknown",
                Influence: "High",
                Ideology: "Imperial Expansion",
                Members: 12000,
            };
        case "lore":
            return {
                Era: "First Age",
                Canon: "Official Record",
                Significance: "Major Historic Event",
            };
    }
}

/**
 * Generates an evocative, professional AI image prompt for Midjourney / SD / Yumon Paint.
 */
export function generateConceptImagePrompt(
    name: string,
    category: CodexCategory,
    subtitle: string,
    description: string,
    genre: GenreType
): string {
    const genreKeywords: Record<GenreType, string> = {
        fantasy: "high fantasy concept art, intricate filigree, atmospheric volume lighting, unreal engine 5, artstation trending",
        scifi: "hard sci-fi cinematic matte painting, futuristic holographic UI accents, hyperdetailed hard surface modeling, octane render",
        cyberpunk: "cyberpunk 2077 aesthetic, volumetric neon glare, rain-slicked chrome, dark synthwave palette, raytracing",
        postapoc: "gritty post-apocalyptic concept art, weathered oxidized metal, scavenged gear, overgrown wasteland foliage, photorealistic",
        steampunk: "steampunk technical schematic and portrait, polished brass gears, steam exhaust, Victorian industrialism, sepia tones",
        historical: "authentic historical illustration, museum archival oil painting, natural daylighting, dramatic chiaroscuro",
    };

    const style = genreKeywords[genre] || genreKeywords.fantasy;

    switch (category) {
        case "character":
            return `Character concept portrait of ${name}, ${subtitle}. ${description.slice(0, 120)}. Highly detailed character design, full body presentation, ${style}, 8k resolution`;
        case "power":
            return `Dynamic spell visual effect of ${name}, ${subtitle}. Magical energy radiating and distorting spacetime, particulate embers, vibrant luminous runes, ${style}`;
        case "weapon":
            return `Hero prop beauty shot of ${name}, ${subtitle}. ${description.slice(0, 100)}. Isometric lighting showcase, worn edge details, weapon forging concept, ${style}`;
        case "faction":
            return `Banner heraldry and military legion inspection of ${name}, ${subtitle}. Regalia, standardized uniform armaments, grand architectural stronghold backdrop, ${style}`;
        case "lore":
            return `Historical chronicle matte painting depicting ${name}. ${description.slice(0, 140)}. Epic cinematic panorama, dramatic clouds and storytelling composition, ${style}`;
    }
}

export function filterCodexByCategory(entries: CodexEntry[], category?: CodexCategory | "all"): CodexEntry[] {
    if (!category || category === "all") return entries;
    return entries.filter((e) => e.category === category);
}

export function linkCodexToSpot(entry: CodexEntry, spot: WorldSpot): void {
    if (!entry.linkedSpotIds.includes(spot.id)) {
        entry.linkedSpotIds.push(spot.id);
    }
    if (!spot.linkedCodexIds.includes(entry.id)) {
        spot.linkedCodexIds.push(entry.id);
    }
}

export function unlinkCodexFromSpot(entry: CodexEntry, spot: WorldSpot): void {
    entry.linkedSpotIds = entry.linkedSpotIds.filter((id) => id !== spot.id);
    spot.linkedCodexIds = spot.linkedCodexIds.filter((id) => id !== entry.id);
}
