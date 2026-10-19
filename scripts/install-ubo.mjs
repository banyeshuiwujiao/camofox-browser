#!/usr/bin/env node
// install-ubo.mjs — (re)install the signed uBlock Origin addon into camoufox's
// addon cache so camoufox-js loads it WITHOUT downloading at launch.
//
// Why: camoufox-js downloads UBO from addons.mozilla.org inside launchOptions(),
// which server.js wraps in a 10s timeout (GEOIP_SETUP_TIMEOUT_MS). When AMO is
// unreachable/slow (e.g. the egress IP is blocked by Mozilla's CDN with HTTP 406,
// or the proxy is flaky), the download blows past 10s and every browser launch
// fails with "GeoIP setup timed out after 10000ms". Pre-seeding the cache makes
// maybeDownloadAddons() find the addon on disk and skip the download entirely,
// so launch is fast and network-independent.
//
// Usage:
//   node scripts/install-ubo.mjs                 # download from AMO + extract + enable in config
//   node scripts/install-ubo.mjs path/to/ubo.xpi # use a local XPI instead of downloading
//   node scripts/install-ubo.mjs --check         # only verify the cached addon is present/valid
//   node scripts/install-ubo.mjs --no-config     # skip flipping disableDefaultAddons:false
//
// Re-run this after a camoufox/camoufox-js update wipes the cache.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_DIR, unzip } from 'camoufox-js/dist/pkgman.js';
import { DefaultAddons } from 'camoufox-js/dist/addons.js';

const AMO_URL = DefaultAddons.UBO; // https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const ADDON_DIR = path.join(INSTALL_DIR, 'addons', 'UBO');
const CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'camofox.config.json');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const localXpi = args.find((a) => !a.startsWith('--')) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...m) { console.log(...m); }
function die(msg, code = 1) { console.error('ERROR: ' + msg); process.exit(code); }

function verifyAddon() {
  const manifestPath = path.join(ADDON_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { name: m.name, version: m.version };
  } catch { return { name: '(unparsable manifest)', version: '?' }; }
}

// Resumable chunked download: survives flaky proxies by re-requesting only the
// missing tail via HTTP Range and appending. Returns the file path.
async function downloadXpi(outFile) {
  if (fs.existsSync(outFile)) fs.rmSync(outFile);
  const CHUNK = 262144;
  const have = () => (fs.existsSync(outFile) ? fs.statSync(outFile).size : 0);
  const range = async (start, end) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000);
    try {
      const r = await fetch(AMO_URL, { signal: c.signal, redirect: 'follow', headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` } });
      clearTimeout(t);
      if (r.status !== 206 && r.status !== 200) { log(`  range status=${r.status}`); return null; }
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { clearTimeout(t); log('  range ERR ' + (e.cause ? (e.cause.code || e.cause) : e.message)); return null; }
  };
  let total = 0;
  for (let i = 0; i < 20 && !total; i++) {
    const buf = await range(0, 0);
    // content-range not exposed on arrayBuffer path; re-probe headers instead
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
    try { const r = await fetch(AMO_URL, { signal: c.signal, redirect: 'follow', headers: { 'User-Agent': UA, Range: 'bytes=0-0' } }); clearTimeout(t); const cr = r.headers.get('content-range'); if (cr) total = parseInt(cr.split('/')[1], 10); } catch { clearTimeout(t); }
    if (!total) await sleep(3000);
  }
  if (!total) die(`could not determine size of ${AMO_URL}. The egress IP may be blocked by Mozilla (HTTP 406) or the proxy is down. Use a working TUN proxy, or pass a local XPI: node scripts/install-ubo.mjs path/to/ubo.xpi`);
  log(`  target size=${total}`);
  let attempts = 0;
  while (have() < total) {
    const h = have();
    const buf = await range(h, Math.min(h + CHUNK - 1, total - 1));
    if (buf && buf.length > 0) { fs.appendFileSync(outFile, buf); attempts = 0; }
    else { attempts++; if (attempts > 60) die(`download stalled at ${have()}/${total}. Retry, use a working proxy, or pass a local XPI.`); await sleep(3000); }
  }
  return outFile;
}

async function main() {
  log('camoufox INSTALL_DIR : ' + INSTALL_DIR);
  log('UBO addon dir        : ' + ADDON_DIR);

  if (flags.has('--check')) {
    const v = verifyAddon();
    if (v) { log(`OK — cached addon present: ${v.name} ${v.version}`); process.exit(0); }
    log('MISSING — no valid cached addon. Run: node scripts/install-ubo.mjs');
    process.exit(2);
  }

  let xpi;
  if (localXpi) {
    if (!fs.existsSync(localXpi)) die(`local XPI not found: ${localXpi}`);
    xpi = path.resolve(localXpi);
    log('source: local XPI ' + xpi);
  } else {
    log('source: downloading from AMO (resumable) ...');
    const tmp = path.join(path.dirname(ADDON_DIR), 'ubo-download.xpi');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    xpi = await downloadXpi(tmp);
    log('  downloaded ' + fs.statSync(xpi).size + ' bytes');
  }

  // Extract (camoufox-js uses adm-zip via unzip(); match it exactly).
  if (fs.existsSync(ADDON_DIR)) fs.rmSync(ADDON_DIR, { recursive: true, force: true });
  fs.mkdirSync(ADDON_DIR, { recursive: true });
  const buf = fs.readFileSync(xpi);
  await unzip(buf, ADDON_DIR, 'Extracting addon (UBO)', false);

  const v = verifyAddon();
  if (!v) { fs.rmSync(ADDON_DIR, { recursive: true, force: true }); die('extraction produced no manifest.json — not a valid XPI?'); }
  log(`extracted: ${v.name} ${v.version} -> ${ADDON_DIR}`);

  if (!localXpi) { try { fs.rmSync(xpi, { force: true }); } catch {} }

  if (!flags.has('--no-config')) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.disableDefaultAddons !== false) {
        cfg.disableDefaultAddons = false;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
        log('config: set disableDefaultAddons=false in ' + CONFIG_PATH);
      } else {
        log('config: disableDefaultAddons already false');
      }
    } catch (e) { log('WARN: could not update config (' + e.message + '). Set "disableDefaultAddons": false manually.'); }
  }

  log('\nDone. Restart the camofox server so it re-reads config, then verify:');
  log('  node scripts/install-ubo.mjs --check');
}

main().catch((e) => die(e.stack || e.message));
