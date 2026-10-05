// Usage: node scripts/analyze-allegiance-profile.mjs <frames.jsonl> [summary.json]
// GPU results arrive later and several readbacks may accumulate in one frame. Normalize
// accumulated GPU durations by their sample counters, not frame count or phase p50.
import { readFileSync, writeFileSync } from 'node:fs';

const windows = readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const groups = new Map();
for (const window of windows) {
  const id = window.phases['#al experiment'];
  if (!id || id.avg !== id.max || id.avg !== id.p50 || id.avg === 0) continue;
  const group = groups.get(id.avg) ?? [];
  group.push(window);
  groups.set(id.avg, group);
}
const results = [];
for (const [experiment, all] of groups) {
  // Discard the first pure window too, allowing outstanding GPU work to drain.
  const steady = all.slice(1);
  if (!steady.length) continue;
  const frames = steady.reduce((sum, w) => sum + w.frames, 0);
  const names = new Set(steady.flatMap(w => Object.keys(w.phases)));
  const phases = {};
  for (const name of names) {
    const sum = steady.reduce((total, w) => total + (w.phases[name]?.avg ?? 0) * w.frames, 0);
    if (name.startsWith('gpu ')) {
      const samples = steady.reduce((total, w) => total + (w.phases[`#samples ${name}`]?.avg ?? 0) * w.frames, 0);
      phases[name] = { meanMs: samples ? sum / samples : null, samples };
    } else phases[name] = { avg: sum / frames };
  }
  results.push({ experiment, frames, phases });
}
const output = JSON.stringify(results, null, 2);
if (process.argv[3]) writeFileSync(process.argv[3], output + '\n', 'utf8');
else console.log(output);
