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
// Valid level counts: 1-18, including the root. Halving rounds down, with a minimum of 3.
//
// Planet scale: the planets are 58-100 km in radius, so a root face is 90-160 km across and each
// level halves that. Fourteen levels put Verdant's leaf chunks at ~19 m (0.3 m between vertices
// with 64 per side), fine enough for the rocks and stones you walk over; fewer levels leave the
// ground coarse underfoot (eight levels would make Verdant's leaves ~1.2 km).
// Applies to every planet unless its PlanetDef.chunkDetail or runtime config overrides it.
// export const DEFAULT_CHUNK_DETAIL: ChunkDetail | undefined = undefined;

// Leaf (level 13, ~19 m chunks on Verdant) first, root face last. The few coarsest chunks (what
// you see from orbit, tens of kilometers each) get more vertices so coastlines and the limb
// don't turn blocky; there are only a few dozen of them, so they are cheap.
export const DEFAULT_CHUNK_DETAIL: ChunkDetail | undefined = {
    mode: "explicit", verticesPerLevel: [64, 32, 32, 32, 32, 32, 32, 32, 32, 48, 48, 64, 64, 64],
};
