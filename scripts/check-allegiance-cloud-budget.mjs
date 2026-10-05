// Usage: node scripts/check-allegiance-cloud-budget.mjs <summary.json> <result.json>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const measurements = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const result = JSON.parse(readFileSync(process.argv[3], 'utf8'));
assert.equal(result.status, 'passed');
const byId = new Map(measurements.map(m => [m.experiment, m]));
const mean = (ids, phase, property = 'avg') => {
  for (const id of ids) assert.ok(byId.get(id)?.frames >= 90, `insufficient steady samples for ${id}`);
  return ids.reduce((sum, id) => sum + byId.get(id).phases[phase][property], 0) / ids.length;
};
const reference = mean([51, 55], 'frame interval');
const cached = mean([52, 54, 56, 58], 'frame interval');
const clear = mean([53, 57], 'frame interval');
const gpuCached = mean([52, 54, 56, 58], 'gpu non-PBR pass', 'meanMs');
const gpuClear = mean([53, 57], 'gpu non-PBR pass', 'meanMs');
// Also check the later adjacent cached/clear/cached bracket, reducing startup clock drift.
const lateCached = mean([56, 58], 'frame interval');
const lateClear = mean([57], 'frame interval');
const states = result.tools.filter(t => t.tool === 'allegiance_state').map(t => t.result);
assert.equal(states.length, 9);
for (const state of states) {
  assert.equal(state.mode, 'play');
  assert.equal(state.fixedStep, null);
  assert.equal(state.terrain.pending, 0);
  assert.equal(state.terrain.waitingForData, 0);
  assert.equal(state.profile.disable, 'none');
}
for (const state of states.slice(0, 8)) {
  assert.equal(state.profile.freeze, true);
  assert.deepEqual(state.player, states[0].player, 'camera/player held for comparison');
  assert.equal(state.terrain.triangles, states[0].terrain.triangles);
}
assert.equal(states.at(-1).profile.freeze, false);
assert.equal(states.at(-1).sky.cloudCache, true);
const report = {
  referenceFrameMs: reference, cachedFrameMs: cached, clearFrameMs: clear,
  referenceCloudMs: reference - clear, cachedCloudMs: cached - clear,
  referenceCloudShare: (reference - clear) / reference,
  cachedCloudShare: (cached - clear) / cached,
  gpuCloudMs: gpuCached - gpuClear,
  frameReduction: 1 - cached / reference,
  lateCachedFrameMs: lateCached, lateClearFrameMs: lateClear,
  lateCloudShare: (lateCached - lateClear) / lateCached,
};
console.log(JSON.stringify(report, null, 2));
assert.ok(report.cachedCloudShare >= 0, 'negative delta: measurements need repeating');
assert.ok(report.cachedCloudShare <= 0.05, 'clouds exceed the 5% frame budget on this replay');
assert.ok(report.lateCloudShare >= 0 && report.lateCloudShare <= 0.05, 'later matched controls exceed the 5% cloud budget');
