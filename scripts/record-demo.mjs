// Record the demo footage: a real browser, against the real miner.
//
//   node scripts/record-demo.mjs                     # the live deployment
//   DEMO_BASE=http://localhost:8787 node scripts/record-demo.mjs
//
// Every clip is a genuine session. Nothing is mocked, nothing is sped up here,
// and the numbers on screen are whatever the chain and Open-Meteo said at the
// moment of recording — which is the only kind of demo worth showing for a
// project whose whole argument is that its figures are checkable.
//
// One BrowserContext per scene, because Playwright writes one video per context.
// The clips land in media/raw/<scene>.webm and Remotion sequences them.
//
// ponytail: no test runner. These are not assertions, they are camera moves, and
// putting them in the suite would record video on every CI run.

import { chromium } from "@playwright/test";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../media/raw");
const BASE = (process.env.DEMO_BASE ?? "https://amanat-miner.vercel.app").replace(/\/+$/, "");
const SIZE = { width: 1600, height: 900 };

/** Long enough to read, short enough to keep. */
const beat = (page, ms = 1200) => page.waitForTimeout(ms);

/**
 * Run one scene into its own video file.
 *
 * Playwright names the file by an internal id and only flushes it on
 * `context.close()`, so the rename happens after — there is no API for
 * "call it this".
 */
async function scene(browser, name, fn) {
  const dir = join(OUT, `.${name}`);
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir, size: SIZE },
    deviceScaleFactor: 2,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await context.close();
  }
  const [file] = await readdir(dir);
  await rename(join(dir, file), join(OUT, `${name}.webm`));
  await rm(dir, { recursive: true, force: true });
  console.log(`  ${name}.webm`);
}

const scenes = {
  // A place in, a risk out, and the band it sits in. The first thing anyone
  // does with this site.
  async reading(page) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await beat(page, 1800);
    const ask = page.locator("#ask");
    await ask.scrollIntoViewIfNeeded();
    await beat(page, 600);
    await ask.click();
    await ask.pressSequentially("Cebu", { delay: 130 });
    await beat(page, 500);
    await page.locator("#go").click();
    await page.locator("#result .summary").waitFor({ state: "visible", timeout: 60_000 });
    await beat(page, 3200);
  },

  // Risk along a route, at the hour the vessel reaches each leg. This is the
  // part a router cannot answer by looking up one place.
  async route(page) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.locator("#routeform").scrollIntoViewIfNeeded();
    await beat(page, 900);
    await page.locator("#routefrom").fill("Cebu");
    await page.locator("#routeto").fill("Manila");
    await beat(page, 500);
    await page.locator("#routego").click();
    await page.locator("#routeresult .leg").first().waitFor({ state: "visible", timeout: 60_000 });
    await beat(page, 3200);
  },

  // The book, read from the chain at load. Two policies, both answered, both
  // declined — with the reason the protocol gave.
  async ledger(page) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.locator("#ledgerbody").scrollIntoViewIfNeeded();
    await page.locator("#ledgerbody tr").first().waitFor({ state: "visible", timeout: 60_000 });
    await beat(page, 4000);
  },

  // The finding, as an endpoint rather than a paragraph.
  async jobable(page) {
    await page.goto(`${BASE}/api/jobable`, { waitUntil: "networkidle" });
    await beat(page, 4000);
  },

  // The deck drives itself off the arrow key.
  async slides(page) {
    await page.goto(`${BASE}/slides`, { waitUntil: "networkidle" });
    await beat(page, 2200);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("ArrowDown");
      await beat(page, 2400);
    }
    await beat(page, 1200);
  },
};

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const names = only.length ? only : Object.keys(scenes);
  for (const n of names) {
    if (!scenes[n]) {
      console.error(`no scene called ${n}. Have: ${Object.keys(scenes).join(", ")}`);
      process.exit(2);
    }
  }

  await mkdir(OUT, { recursive: true });
  console.log(`recording against ${BASE}`);
  const browser = await chromium.launch();
  try {
    for (const name of names) await scene(browser, name, scenes[name]);
  } finally {
    await browser.close();
  }
  console.log(`\nwrote ${names.length} clip(s) to media/raw/`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
