
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(scriptDir, '..', 'previews');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const LIMIT = parseInt(arg('--limit', '0'), 10);
const IDS = (arg('--ids', '')).split(',').filter(s => /^\d+$/.test(s)).map(Number);
const CONCURRENCY = Math.max(1, parseInt(arg('--concurrency', '4'), 10));
const BASE = arg('--base', 'http://127.0.0.1:4200/').replace(/\/?$/, '/');
const TOKEN = process.env.HF_TOKEN || '';

const headers = TOKEN ? { 'X-HF-Token': TOKEN } : {};

const res = await fetch(BASE + 'api/metadata', { headers });
if (!res.ok) {
  console.error(`metadata fetch failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const metadata = await res.json();
let ids = metadata.models.map(m => m.id).sort((a, b) => a - b);
if (IDS.length) ids = ids.filter(id => IDS.includes(id));
if (LIMIT > 0) ids = ids.slice(0, LIMIT);

fs.mkdirSync(OUT_DIR, { recursive: true });
const pending = ids.filter(id => !fs.existsSync(path.join(OUT_DIR, `${id}.webp`)));
console.log(`models: ${ids.length}, to render: ${pending.length} (skipping ${ids.length - pending.length} existing)`);

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const failures = [];
let done = 0;
let bytes = 0;
const t0 = Date.now();

async function makePage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  if (TOKEN) {

    await page.evaluateOnNewDocument(t => localStorage.setItem('pmv-hf-token', t), TOKEN);
  }
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#model-list .model-cell', { timeout: 30000 });

  await page.evaluate(() => {
    document.querySelectorAll('#model-list img').forEach(i => i.remove());
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('panel').style.display = 'none';
    document.getElementById('model-info').style.display = 'none';
    document.querySelector('header').style.display = 'none';
    const stage = document.getElementById('stage');
    stage.style.width = '512px';
    stage.style.height = '384px';
    stage.style.flex = 'none';
    const canvas = document.getElementById('render-canvas');
    canvas.style.flex = 'none';
    canvas.style.width = '512px';
    canvas.style.height = '384px';
    window.dispatchEvent(new Event('resize'));
  });
  return page;
}

async function renderOne(page, id) {
  await page.evaluate((mid) => {
    const cell = document.querySelector(`.model-cell[data-id="${mid}"]`);
    if (!cell) throw new Error(`cell ${mid} not found`);
    cell.click();
  }, id);
  await page.waitForFunction(
    (mid) => {
      const s = document.getElementById('status');
      return (s.textContent === '' || s.className === 'error') &&
        document.getElementById('model-info').textContent.includes(`#${mid} `);
    },
    { timeout: 180000 }, id).catch(() => { });
  const state = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    error: document.getElementById('status').className === 'error',
    info: document.getElementById('model-info').textContent,
  }));
  if (state.error || !state.info.includes(`#${id} `)) {
    throw new Error(state.status || 'model did not load');
  }
  await new Promise(r => setTimeout(r, 250));
  const canvas = await page.$('#render-canvas');
  const shot = await canvas.screenshot({ type: 'webp', quality: 75 });
  fs.writeFileSync(path.join(OUT_DIR, `${id}.webp`), shot);
  return shot.length;
}

async function worker(index) {
  let page = await makePage();
  let sinceReload = 0;
  while (pending.length) {
    const id = pending.shift();
    try {
      const size = await renderOne(page, id);
      bytes += size;
      sinceReload++;
    } catch (e) {
      failures.push({ id, error: String(e.message || e) });
      console.log(`FAILED ${id}: ${e.message || e}`);
      sinceReload = 100;
    }
    done++;
    if (sinceReload >= 100) {
      await page.close().catch(() => { });
      page = await makePage();
      sinceReload = 0;
    }
    if (done % 25 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      const eta = (pending.length / CONCURRENCY) * (elapsed / Math.max(done, 1));
      console.log(`progress ${done}/${ids.length} | ${(bytes / 1024 / done).toFixed(1)} KB avg | ` +
        `${elapsed.toFixed(0)}s elapsed | eta ${(eta / 60).toFixed(1)}min`);
    }
  }
  await page.close().catch(() => { });
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
await browser.close();

const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
console.log('---');
console.log(`rendered ${done} previews in ${elapsed}min, ` +
  `${(bytes / 1024 / Math.max(done, 1)).toFixed(1)} KB average`);
if (failures.length) {
  console.log(`failures (${failures.length}):`, failures);
}
console.log('PREVIEW BATCH DONE');
