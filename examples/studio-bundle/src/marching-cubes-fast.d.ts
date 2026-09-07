// Type definitions for marching-cubes-fast

declare module 'marching-cubes-fast' {
  /**
   * A 3D vector represented as [x, y, z]
   */
  export type Vec3 = [number, number, number];

  /**
   * Scanning bounds: [[minX, minY, minZ], [maxX, maxY, maxZ]]
   */
  export type Bounds = [Vec3, Vec3];

  /**
   * Signed Distance Function (SDF) or Density function.
   * Returns a value where > 0 is typically solid and < 0 is empty (or vice versa depending on threshold).
   */
  export type SDF = (x: number, y: number, z: number) => number;

  export interface Mesh {
    /** Array of vertex positions [x, y, z] */
    positions: Vec3[];
    /** Array of faces (indices into positions) [i1, i2, i3] */
    cells: Vec3[];
    /** Optional array of vertex normals [nx, ny, nz] */
    normals?: Vec3[];
  }

  /**
   * Standard Marching Cubes algorithm to extract an isosurface from a density field.
   * 
   * @param resolution The grid resolution (typically a power of 2 like 32, 64)
   * @param sdf The density function to sample
   * @param bounds The bounding box to scan
   */
  export function marchingCubes(
    resolution: number,
    sdf: SDF,
    bounds: Bounds
  ): Mesh;

  /**
   * Version of marching cubes that works on a specific list of voxels.
   */
  export function marchingCubesVoxelList(
    resolution: number,
    sdf: SDF,
    bounds: Bounds,
    voxels: any[]
  ): Mesh;

  // The module exports the primary marchingCubes function as default
  export default marchingCubes;
}
