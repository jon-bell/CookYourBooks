#!/usr/bin/env node
// App Store screenshot pipeline.
//
// Builds a screenshot flavour of the app (the web bundle with
// VITE_SCREENSHOT_CONTROL_URL set, which compiles in
// apps/web/src/screenshots/driver.ts), then for each device: creates a
// throwaway simulator, pins the status bar to Apple's 9:41 look, installs +
// launches the app, and serves the driver a script over HTTP on 127.0.0.1.
// The driver signs in as the demo account, walks the steps, and asks us to
// take each screenshot with `simctl io screenshot` — so the images are real
// device-resolution captures of the real app, status bar included.
//
// Usage (macOS with Xcode):
//   CYB_SCREENSHOT_EMAIL=… CYB_SCREENSHOT_PASSWORD=… \
//     node scripts/ios-screenshots/capture.mjs
//
// Options (env):
//   CYB_SCREENSHOT_DEVICES  comma-separated device-type names; each entry may
//                           be "A|B" to fall back to B when A isn't installed.
//   CYB_SCREENSHOT_OUT      output dir (default apps/mobile/screenshots/en-US,
//                           the layout `fastlane deliver` expects).
//   CYB_SCREENSHOT_PORT     control-server port (default 8977).
//   CYB_SCREENSHOT_SKIP_BUILD=1  reuse the last screenshot build.
//   CYB_DEMO_CONTENT        demo-content corpus for the import steps (default
//                           scripts/demo-content/out; see PR #120's fetch.ts).
//
// `--web` runs the same driver + protocol in headless Chromium against
// `vite preview` instead of a simulator — a fast way to check the steps on a
// Linux box (needs local Supabase or VITE_SUPABASE_* pointing somewhere).

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE_ID = 'app.cookyourbooks';
const WEB_MODE = process.argv.includes('--web');
const PORT = Number(process.env.CYB_SCREENSHOT_PORT ?? 8977);
const CONTROL_URL = `http://127.0.0.1:${PORT}`;
const OUT = resolve(process.env.CYB_SCREENSHOT_OUT ?? join(REPO, 'apps/mobile/screenshots/en-US'));
const STEPS = JSON.parse(readFileSync(join(REPO, 'scripts/ios-screenshots/steps.json'), 'utf8'));
// Demo-content corpus (scripts/demo-content/fetch.ts output) for the import
// steps. Missing is fine: the driver skips import steps it can't feed.
const CORPUS = resolve(process.env.CYB_DEMO_CONTENT ?? join(REPO, 'scripts/demo-content/out'));

// App Store Connect's required sizes: 6.9" iPhone (1320×2868) and, because
// the app runs on iPad, 13" iPad (2064×2752). Fallbacks cover older Xcodes.
const DEVICES = (
  process.env.CYB_SCREENSHOT_DEVICES ??
  'iPhone 17 Pro Max|iPhone 16 Pro Max,iPad Pro 13-inch (M5)|iPad Pro 13-inch (M4)'
)
  .split(',')
  .map((d) => d.split('|').map((s) => s.trim()));

// Web-mode viewports (CSS px) matching the two store sizes.
const WEB_VIEWPORTS = [
  { label: 'iPhone', width: 440, height: 956, scale: 3 },
  { label: 'iPad', width: 1032, height: 1376, scale: 2 },
];

const email = process.env.CYB_SCREENSHOT_EMAIL;
const password = process.env.CYB_SCREENSHOT_PASSWORD;
if (!email || !password) {
  console.error('Set CYB_SCREENSHOT_EMAIL and CYB_SCREENSHOT_PASSWORD (the demo account).');
  process.exit(2);
}

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO, ...opts });
const shOut = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8' });
const log = (msg) => console.log(`==> ${msg}`);

// ---------------------------------------------------------------- control server
//
// One device at a time. `current` holds the capture callback + the promise
// resolvers for the run in progress.

let current = null;

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  let body = '';
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : {};
  if (!current) return reply(409, { error: 'no device run in progress' });

  // Corpus endpoints for the import steps.
  const url = decodeURIComponent(req.url ?? '');
  if (url.startsWith('/corpus/')) {
    const book = readCorpusBook(url.slice('/corpus/'.length));
    return book ? reply(200, book) : reply(404, { error: `no corpus book at ${CORPUS}` });
  }
  if (url.startsWith('/asset/')) {
    const file = resolve(CORPUS, url.slice('/asset/'.length));
    if (!file.startsWith(CORPUS + sep) || !existsSync(file)) return reply(404, { error: 'no asset' });
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(readFileSync(file));
  }

  try {
    switch (req.url) {
      case '/script':
        return reply(200, { email, password, steps: STEPS });
      case '/log':
        console.log(`   [app] ${json.msg}`);
        return reply(200, { ok: true });
      case '/shot': {
        const file = join(OUT, `${current.prefix}-${json.name}.png`);
        await current.capture(file);
        console.log(`   captured ${file}`);
        current.count += 1;
        return reply(200, { ok: true });
      }
      case '/done':
        reply(200, { ok: true });
        return json.ok ? current.resolve() : current.reject(new Error(json.error));
      default:
        return reply(404, { error: 'unknown endpoint' });
    }
  } catch (err) {
    reply(500, { error: String(err) });
    current.reject(err);
  }
});

/** One demo-content book: source.json metadata + its recipe page folders,
 *  with page paths relative to the corpus root (for /asset/<path>). */
function readCorpusBook(id) {
  const dir = join(CORPUS, id);
  if (id.includes('/') || !existsSync(join(dir, 'source.json'))) return null;
  const src = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'));
  const pagesDir = join(dir, 'pages');
  const recipes = existsSync(pagesDir)
    ? readdirSync(pagesDir)
        .sort()
        .filter((slug) => statSync(join(pagesDir, slug)).isDirectory())
        .map((slug) => ({
          slug,
          pages: readdirSync(join(pagesDir, slug))
            .filter((f) => /\.jpe?g$/i.test(f))
            .sort()
            .map((f) => relative(CORPUS, join(pagesDir, slug, f))),
        }))
    : [];
  return {
    id,
    title: src.title ?? id,
    author: src.author ?? null,
    year: src.year ?? null,
    collection: src.collection ?? 'cookbook',
    recipes,
  };
}

function runDevice(prefix, capture, timeoutMs = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${prefix}: timed out`)), timeoutMs);
    current = {
      prefix,
      capture,
      count: 0,
      resolve: () => {
        clearTimeout(timer);
        resolve(current.count);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
  });
}

// ---------------------------------------------------------------- build

function buildWeb() {
  // Vite picks up VITE_* from the process env on top of apps/web/.env.local.
  process.env.VITE_SCREENSHOT_CONTROL_URL = CONTROL_URL;
  if (WEB_MODE) {
    log('building web (screenshot flavour)');
    sh('pnpm', ['--filter', '@cookyourbooks/web', 'build']);
  } else {
    log('building web + cap sync (screenshot flavour)');
    sh('pnpm', ['--filter', '@cookyourbooks/mobile', 'sync']);
  }
}

const IOS_DIR = join(REPO, 'apps/mobile/ios/App');
const DERIVED = join(IOS_DIR, 'shots-build');
const APP_PATH = join(DERIVED, 'Build/Products/Release-iphonesimulator/App.app');

function buildIos() {
  // The driver talks to the host over plain http://127.0.0.1. ATS needs the
  // local-networking exemption for that; add it to THIS build only (the
  // committed Info.plist, and so every shipped build, stays strict).
  const plist = join(IOS_DIR, 'App/Info.plist');
  const backup = `${plist}.shots-bak`;
  copyFileSync(plist, backup);
  try {
    const pb = (cmd) => {
      try {
        sh('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { stdio: 'ignore' });
      } catch {
        /* key already present / absent — fine */
      }
    };
    pb('Add :NSAppTransportSecurity dict');
    pb('Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true');
    log('xcodebuild Release for the simulator');
    sh(
      'xcodebuild',
      [
        '-workspace',
        'App.xcworkspace',
        '-scheme',
        'App',
        '-configuration',
        'Release',
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        DERIVED,
        'CODE_SIGNING_ALLOWED=NO',
        '-quiet',
        'build',
      ],
      { cwd: IOS_DIR },
    );
  } finally {
    copyFileSync(backup, plist);
    rmSync(backup);
  }
  if (!existsSync(APP_PATH)) throw new Error(`built app not found at ${APP_PATH}`);
}

// ---------------------------------------------------------------- simulator

function resolveDeviceType(candidates) {
  const { devicetypes } = JSON.parse(shOut('xcrun', ['simctl', 'list', 'devicetypes', '-j']));
  for (const name of candidates) {
    const hit = devicetypes.find((d) => d.name === name);
    if (hit) return hit;
  }
  throw new Error(`none of these device types are installed: ${candidates.join(', ')}`);
}

function latestIosRuntime() {
  const { runtimes } = JSON.parse(shOut('xcrun', ['simctl', 'list', 'runtimes', '-j']));
  const ios = runtimes
    .filter((r) => r.isAvailable && r.platform === 'iOS')
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  if (ios.length === 0) throw new Error('no iOS simulator runtime installed');
  return ios.at(-1);
}

async function shootSimulator(candidates, runtime) {
  const type = resolveDeviceType(candidates);
  const prefix = type.name.replace(/[^A-Za-z0-9]+/g, '_');
  log(`${type.name} (${runtime.name})`);
  const udid = shOut('xcrun', [
    'simctl',
    'create',
    `cyb-shots ${type.name}`,
    type.identifier,
    runtime.identifier,
  ]).trim();
  try {
    sh('xcrun', ['simctl', 'boot', udid]);
    sh('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'ignore' });
    sh('xcrun', ['simctl', 'ui', udid, 'appearance', 'light']);
    // Apple's marketing status bar: 9:41, full signal, full battery.
    sh('xcrun', [
      'simctl',
      'status_bar',
      udid,
      'override',
      '--time',
      '9:41',
      '--dataNetwork',
      'wifi',
      '--wifiMode',
      'active',
      '--wifiBars',
      '3',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
    ]);
    sh('xcrun', ['simctl', 'install', udid, APP_PATH]);
    const done = runDevice(prefix, async (file) => {
      execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', file], {
        stdio: 'ignore',
      });
    });
    sh('xcrun', ['simctl', 'launch', udid, BUNDLE_ID]);
    const n = await done;
    log(`${type.name}: ${n} screenshots`);
  } finally {
    try {
      sh('xcrun', ['simctl', 'shutdown', udid], { stdio: 'ignore' });
    } catch {
      /* already down */
    }
    sh('xcrun', ['simctl', 'delete', udid], { stdio: 'ignore' });
  }
}

// ---------------------------------------------------------------- web mode

async function shootWeb() {
  const { chromium } = await import(
    join(REPO, 'apps/web/node_modules/@playwright/test/index.mjs')
  );
  const preview = spawn(
    'pnpm',
    ['--filter', '@cookyourbooks/web', 'exec', 'vite', 'preview', '--port', '4180', '--strictPort'],
    { cwd: REPO, stdio: 'ignore' },
  );
  try {
    await new Promise((r) => setTimeout(r, 3000));
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    });
    try {
      for (const vp of WEB_VIEWPORTS) {
        log(`web ${vp.label} ${vp.width}×${vp.height}@${vp.scale}x`);
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: vp.scale,
          isMobile: true,
          hasTouch: true,
          colorScheme: 'light',
        });
        const page = await ctx.newPage();
        page.on('console', (m) => {
          if (m.type() === 'error') console.log(`   [console] ${m.text()}`);
        });
        const done = runDevice(`web_${vp.label}`, (file) => page.screenshot({ path: file }));
        await page.goto('http://localhost:4180/');
        const n = await done;
        log(`web ${vp.label}: ${n} screenshots`);
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill();
  }
}

// ---------------------------------------------------------------- main

async function main() {
  mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  try {
    if (process.env.CYB_SCREENSHOT_SKIP_BUILD !== '1') {
      buildWeb();
      if (!WEB_MODE) buildIos();
    }
    if (WEB_MODE) {
      await shootWeb();
    } else {
      sh('xcrun', ['simctl', 'shutdown', 'all'], { stdio: 'ignore' });
      const runtime = latestIosRuntime();
      for (const candidates of DEVICES) await shootSimulator(candidates, runtime);
    }
    log(`screenshots in ${OUT}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
