// QuadPlanet terrain detail settings. Edit DEFAULT_CHUNK_DETAIL below, then rebuild the addon.
// Counts apply to chunk interiors; border resolution and stitching are handled separately.
//
// Chunk size still changes with quadtree level: approaching terrain splits a chunk into four
// smaller chunks; moving away merges them back. Each coarser level spans twice the width
// and height in cube-face coordinates (roughly four times the surface area on the planet).
// These settings additionally control vertex counts within those differently sized chunks.
// Even equal counts at every level give finer vertex spacing in the smaller, nearby chunks.

export type ChunkDetail =
    | { mode: "half"; leafVertices: number; levels: number }
    | { mode: "explicit"; verticesPerLevel: readonly number[] };

// undefined keeps the existing automatic depth and 17-vertex grid defaults.
// Choose ONE of these values:
//
// Automatic halving (leaf to root: 64, 32, 16, 8, 4, 3, 3, 3):
//   { mode: "half", leafVertices: 64, levels: 8 }
//
// Explicit counts, deepest leaf FIRST and root face LAST:
//   { mode: "explicit", verticesPerLevel: [64, 48, 32, 24, 16, 12, 8, 4] }
//   The list length sets the number of levels.
// Note:
// since chunks get larger as far away, you can stretch vertices over them, but we especially want to control the max interior vertex count
// { mode: "explicit", verticesPerLevel: [17, 17, 17, 17, 17, 17, 17, 17] } // works, but low max
//
// Valid counts: 3-257 vertices per side, including endpoints (64 gives a 62x62 interior).
// Valid level counts: 1-13, including the root. Halving rounds down, with a minimum of 3.
// Applies to every planet unless its PlanetDef.chunkDetail or runtime config overrides it.
// export const DEFAULT_CHUNK_DETAIL: ChunkDetail | undefined = undefined;

export const DEFAULT_CHUNK_DETAIL: ChunkDetail | undefined = { mode: "explicit", verticesPerLevel: [64, 32, 16, 16, 16, 16, 8, 8] };
