# DAW sample songs

These files are standalone DAW project JSON files. The DAW bundles them into its **Sample song** picker; select one and click **Load sample song**. Loading replaces the current project and saves the chosen song as the new `DAW.json`.

| File | Style | Arrangement |
| --- | --- | --- |
| `neon-tide-edm.json` | EDM, 128 BPM | Rising Phys Mod violins, a sparse drum break, and two drops |
| `afterhours-house.json` | House, 122 BPM | Four-on-the-floor drums, Phys Mod cello chops, and a sparse breakdown |
| `lowlight-hip-hop.json` | Hip hop, 92 BPM | Half-time drums, a drum-led breakdown, and a returning hook |

All sounds use built-in voices and pads; no external samples or plugins are needed. To rebuild the JSON after changing the arrangements, run `node sample-songs/generate.mjs` from `examples/studio-bundle`.
