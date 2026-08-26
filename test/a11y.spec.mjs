// Automated accessibility audit, run against the page as it actually renders.
//
//   npx playwright test a11y
//
// axe-core catches the mechanical failures — contrast below threshold, a
// control with no accessible name, a heading order that skips a level, a
// landmark missing. It cannot judge whether a page is usable, so the keyboard
// and focus checks below do the part a scanner cannot.
//
// The page is audited in three states, because most of it does not exist until
// something has been asked: the empty page, the page showing a reading, and the
// page showing a failure. An audit of the first alone would pass while the
// panel a person actually reads went unchecked.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8799";

const FORECAST = {
  summary: "2026-08-26: Overcast, 26.4-32.6 °C. At 2026-08-26T11:00Z the forecast for 10.32, 123.89 is 29.0 °C with wind 10.7 km/h, gusts 22.7 km/h and 0.0 mm precipitation. Storm risk is low (0.252).",
  place: "10.32, 123.89", lat: 10.32, lon: 123.89, hours: 0,
  temp_c: 29, wind_kmh: 10.7, gust_kmh: 22.7, precip_mm: 0,
  condition: "Overcast", weather_code: 3, temp_min_c: 26.4, temp_max_c: 32.6,
  risk: 0.252, breach: false, valid_at: "2026-08-26T11:00Z", source: "open-meteo",
};

/** Report every violation with the nodes that caused it, not just a count. */
function describe(violations) {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
    .join("\n  ");
}

async function audit(page, context) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations, `${context}:\n  ${describe(violations)}`).toEqual([]);
}

// The ledger renders from the chain, so an audit that leaves it live is an
// audit of whatever Base Sepolia happened to hold that minute. That is how the
// status-pill contrast failure hid: a manual check passed because no policy was
// Active at the time. Every status is pinned here so every pill is audited on
// every run, and a slow RPC can no longer make an accessibility result flaky.
const BOOK = { contract: "0x0700c9300D5cfD8A4b2C7fBbaB2703087AB0590c", policies: 4, outstanding: "4.0", jobBudget: "2.0" };
const POLICIES = {
  total: 4,
  unreadable: 0,
  rows: [
    { id: 4, holder: "0x3AaA5b87bD13BE841E824E62cc4C66004420B7c3", lat: "10.32", lon: "123.89", payout: "1.0", status: "Active", risk: 0 },
    { id: 3, holder: "0x3AaA5b87bD13BE841E824E62cc4C66004420B7c3", lat: "14.60", lon: "120.98", payout: "1.0", status: "Claimed", risk: 0.81 },
    { id: 2, holder: "0x3AaA5b87bD13BE841E824E62cc4C66004420B7c3", lat: "22.30", lon: "114.17", payout: "1.0", status: "Declined", risk: 0.31 },
    { id: 1, holder: "0x3AaA5b87bD13BE841E824E62cc4C66004420B7c3", lat: "-6.20", lon: "106.85", payout: "1.0", status: "Expired", risk: 0 },
  ],
};

test.describe("accessibility @ui", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/book", (route) => route.fulfill({ json: BOOK }));
    await page.route("**/api/policies", (route) => route.fulfill({ json: POLICIES }));
  });

  test("the page as it first loads", async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState("domcontentloaded");
    await audit(page, "initial page");
  });

  test("the page showing a reading", async ({ page }) => {
    await page.route("**/forecast", (route) => route.fulfill({ json: FORECAST }));
    await page.goto(BASE);
    await page.fill("#ask", "10.32, 123.89");
    await page.click("#go");
    await expect(page.locator("#result .summary")).toBeVisible();
    await audit(page, "result panel shown");
  });

  test("the page showing a failure", async ({ page }) => {
    await page.route("**/forecast", (route) => route.fulfill({ status: 400, json: { error: "no place found" } }));
    await page.goto(BASE);
    await page.fill("#ask", "zzzqqq");
    await page.click("#go");
    await expect(page.locator("#result .err")).toBeVisible();
    await audit(page, "error panel shown");
  });

  test("every control has a name a screen reader can announce", async ({ page }) => {
    await page.goto(BASE);
    for (const sel of ["#ask", "#routefrom", "#routeto", "#routespeed"]) {
      const name = await page.locator(sel).evaluate((el) =>
        el.getAttribute("aria-label") ?? el.getAttribute("title") ??
        (el.labels?.length ? el.labels[0].textContent : null));
      expect(name?.trim(), `${sel} has no accessible name`).toBeTruthy();
    }
    for (const sel of ["#go", "#routego"]) {
      expect((await page.locator(sel).textContent())?.trim(), `${sel} has no label`).toBeTruthy();
    }
  });

  test("the whole route form is reachable and operable from the keyboard alone", async ({ page }) => {
    await page.route("**/api/route", (route) =>
      route.fulfill({ json: { from: {}, to: {}, distance_km: 562, speed_kmh: 37, duration_hours: 15, unread: 0, breach: false, worst: { risk: 0.5, eta_hours: 15, lat: 14.6, lon: 121 }, verdict: "Elevated: risk 0.500.", legs: [{ km_from_start: 0, eta_hours: 0, lat: 10.3, lon: 123.8, risk: 0.4 }] } }));

    await page.goto(BASE);
    await page.locator("#routefrom").focus();

    // Tab from origin to destination to speed to the submit control, and fire
    // it with the keyboard. A form that needs a mouse is a form some people
    // cannot use at all.
    const order = [];
    for (let i = 0; i < 4; i++) {
      order.push(await page.evaluate(() => document.activeElement?.id));
      await page.keyboard.press("Tab");
    }
    expect(order).toEqual(["routefrom", "routeto", "routespeed", "routego"]);

    await page.locator("#routego").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#routeresult .leg").first()).toBeVisible();
  });

  test("focus is visible wherever it lands", async ({ page }) => {
    await page.goto(BASE);
    for (const sel of ["#ask", "#go", "#routefrom", "#routego"]) {
      await page.locator(sel).focus();
      const outline = await page.locator(sel).evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth };
      });
      expect(outline.style, `${sel} shows no focus ring`).not.toBe("none");
      expect(parseFloat(outline.width), `${sel} focus ring has no width`).toBeGreaterThan(0);
    }
  });

  test("the page still works with motion turned off", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/forecast", (route) => route.fulfill({ json: FORECAST }));
    await page.goto(BASE);
    await page.fill("#ask", "10.32, 123.89");
    await page.click("#go");
    await expect(page.locator("#result .summary")).toBeVisible();
  });
});
