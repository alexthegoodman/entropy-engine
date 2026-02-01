import { defineConfig } from 'tsdown'

export default defineConfig({
  exports: true,
  format: "esm",
  unbundle: false,
  noExternal: ['simple_terrain_addon'],

})
