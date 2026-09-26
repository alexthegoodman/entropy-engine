// Renders the reel with headless Chromium (deterministic: any frame renders on its own).
//   node capture.mjs stills <outdir> <frame> [frame...]     review stills
//   node capture.mjs frames <outdir> <first> <last>          PNG sequence (one worker)
//   node capture.mjs video <out.mp4> <audio.wav> [workers]   the whole reel, encoded with its audio
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FRAMES = 900;
// The server's root is the repository: the page is tools/reel/renderer/index.html, the fonts come
// from src/fonts, the data from tools/reel/out.
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../../..');
const [mode, out, ...rest] = process.argv.slice(2);

async function withPage(fn) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/tools/reel/renderer/index.html`);
  await page.waitForFunction(() => window.reelReady || window.reelError, null, { timeout: 180000 });
  const err = await page.evaluate(() => window.reelError);
  if (err) { console.error(err); process.exit(1); }
  const frame = async (f) => {
    const url = await page.evaluate((f) => { window.renderFrame(f); return document.getElementById('out').toDataURL('image/png'); }, f);
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  };
  try { await fn(frame); } finally { await browser.close(); server.close(); }
}

const name = (f) => `f${String(f).padStart(4, '0')}.png`;
const t0 = Date.now();
if (mode === 'stills') {
  fs.mkdirSync(out, { recursive: true });
  await withPage(async (frame) => { for (const f of rest.map(Number)) fs.writeFileSync(path.join(out, name(f)), await frame(f)); });
} else if (mode === 'frames') {
  fs.mkdirSync(out, { recursive: true });
  const [first, last] = rest.map(Number);
  await withPage(async (frame) => {
    for (let f = first; f <= last; f++) {
      fs.writeFileSync(path.join(out, name(f)), await frame(f));
      if ((f - first) % 30 === 0) console.error(`[${first}-${last}] frame ${f} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  });
} else if (mode === 'video') {
  const [audio, workersArg = '3'] = rest;
  const workers = Number(workersArg);
  const dir = `${out}.frames`;
  fs.mkdirSync(dir, { recursive: true });
  const per = Math.ceil(FRAMES / workers);
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const a = w * per, b = Math.min(FRAMES - 1, a + per - 1);
    // Skip frames already rendered (a restarted render picks up where it stopped).
    let first = a;
    while (first <= b && fs.existsSync(path.join(dir, name(first)))) first++;
    if (first > b) continue;
    jobs.push(new Promise((res, rej) => {
      const p = spawn(process.execPath, [new URL(import.meta.url).pathname, 'frames', dir, String(first), String(b)], { stdio: ['ignore', 'inherit', 'inherit'] });
      p.on('close', (c) => (c === 0 ? res() : rej(new Error(`worker ${w} exited ${c}`))));
    }));
  }
  await Promise.all(jobs);
  console.error(`frames done in ${((Date.now() - t0) / 1000).toFixed(0)} s; encoding`);
  await new Promise((res, rej) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', path.join(dir, 'f%04d.png'), '-i', audio,
      '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k', '-shortest',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', out], { stdio: 'inherit' });
    ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`))));
  });
}
console.error(`${mode} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
