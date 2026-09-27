// How much of a modelled instrument (strings, brass, the drum kit) runs live: the quality tiers of
// docs/PHYS_MOD_FIDELITY.md (Part A1), as a track saves them. A track plays "draft" or "live";
// "render", the best there is, is what an export always uses, whatever the track plays live.

export type ModelQuality = "draft" | "live";

export const MODEL_QUALITIES: { id: ModelQuality; label: string }[] = [
    { id: "draft", label: "Draft (light on the CPU)" },
    { id: "live", label: "Full" },
];

/** A saved quality, or "live" for anything else (songs saved before tracks had one). */
export function repairQuality(saved: unknown): ModelQuality {
    return saved === "draft" ? "draft" : "live";
}

/** What an export renders at. */
export const EXPORT_QUALITY = "render";
