// Writes Contour Design's sample documents as JSON for the kernel's own tests
// (crates/entropy-cad/tests/samples.rs), so the samples are checked headlessly in Rust.
//   deno run -A --unstable-sloppy-imports tools/cad_fixtures.ts
import { SAMPLES } from "../src/apps/cad_design/design_samples.ts";

const dir = new URL("../../../crates/entropy-cad/tests/fixtures/", import.meta.url);
await Deno.mkdir(dir, { recursive: true });
for (const s of SAMPLES) {
    await Deno.writeTextFile(new URL(`${s.id}.json`, dir), JSON.stringify(s.build(), null, 1) + "\n");
    console.log(`wrote ${s.id}.json`);
}
