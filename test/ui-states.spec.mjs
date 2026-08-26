// The states a real network produces and a test cannot wait around for.
//
//   npx playwright test ui-states
//
// e2e.spec.mjs deliberately hits the real upstream and the real chain: the
// product's claim is that it answers about actual weather, and a suite that
// mocked that would test the mocks. This file is the complement, not a
// replacement. A 500 from the miner, a request that never returns, a user who
// double-clicks — none of those can be summoned on demand from a working
// service, and every one of them is a state a person will meet.
//
// So the interception here stands in for conditions, never for data. Nothing in
// this file asserts a forecast value; it asserts what the page does while it is
// waiting, and what it says when the answer never comes.

import { test, expect } from "@playwright/test";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8799";

/** A forecast body shaped like the miner's, used only to let a request finish. */
const FORECAST = {
  summary: "2026-08-26: Overcast, 26.4-32.6 °C. At 2026-08-26T11:00Z the forecast for 10.32, 123.89 is 29.0 °C with wind 10.7 km/h, gusts 22.7 km/h and 0.0 mm precipitation. Storm risk is low (0.252).",
  place: "10.32, 123.89", lat: 10.32, lon: 123.89, hours: 0,
  temp_c: 29, wind_kmh: 10.7, gust_kmh: 22.7, precip_mm: 0,
  condition: "Overcast", weather_code: 3, temp_min_c: 26.4, temp_max_c: 32.6,
  risk: 0.252, breach: false, valid_at: "2026-08-26T11:00Z", source: "open-meteo",
};

test.describe("what the page does while it waits @ui", () => {
  test("shows a busy control and refuses a second submit until the first returns", async ({ page }) => {
    let inFlight = 0;
    let peak = 0;
    let total = 0;

    // The gauge fires five forecasts of its own for the watch stations on load,
    // and since it asks the same way the form does, the only thing that tells
    // them apart is what was asked. Nothing on the page asks about Rotterdam
    // unless a person typed it.
    const TYPED = "Rotterdam";

    // The request is held open until this test lets go of it, rather than for a
    // fixed delay. A sleep long enough on an idle machine is not long enough on
    // a loaded one: the clicks below can outlast it, the button re-enables
    // underneath them, and a second submission gets through — which looks
    // exactly like the bug this test is here to catch.
    let release;
    const held = new Promise((r) => { release = r; });

    await page.route("**/forecast", async (route) => {
      const asked = (route.request().postDataJSON() ?? {}).question;
      if (asked !== TYPED) return route.fulfill({ json: FORECAST });

      inFlight++;
      total++;
      peak = Math.max(peak, inFlight);
      await held;
      inFlight--;
      await route.fulfill({ json: FORECAST });
    });

    await page.goto(BASE);
    await page.fill("#ask", TYPED);

    const go = page.locator("#go");
    await go.click();

    // The loading state has to be visible, not merely brief: a control that
    // looks idle while a request is in flight invites the second click.
    await expect(go).toBeDisabled();
    await expect(go).toHaveText("Reading…");

    // A double-click is the most ordinary thing a person does to a button that
    // has not visibly reacted. It must not buy two answers.
    await go.click({ force: true, timeout: 2000 }).catch(() => {});
    await go.click({ force: true, timeout: 2000 }).catch(() => {});

    // Nothing may have slipped past while the first request was still open.
    expect(peak, "two forecasts must never be in flight at once").toBe(1);
    expect(total, "a double click must not pay for two answers").toBe(1);

    release();
    await expect(page.locator("#result .summary")).toBeVisible();
    await expect(go).toBeEnabled();
    await expect(go).toHaveText("Read the risk");
    expect(total, "and still only one answer was bought").toBe(1);
  });

  test("recovers the control after a failure, so one bad input does not end the session", async ({ page }) => {
    await page.route("**/forecast", (route) =>
      route.fulfill({ status: 502, json: { error: "open-meteo 503" } }));

    await page.goto(BASE);
    await page.fill("#ask", "Cebu");
    await page.click("#go");

    // The miner's own message, not a generic apology — it names what failed.
    await expect(page.locator("#result .err")).toContainText("open-meteo 503");
    await expect(page.locator("#go")).toBeEnabled();
    await expect(page.locator("#go")).toHaveText("Read the risk");

    // and the session continues: a second attempt still works
    await page.unroute("**/forecast");
    await page.route("**/forecast", (route) => route.fulfill({ json: FORECAST }));
    await page.click("#go");
    await expect(page.locator("#result .summary")).toBeVisible();
  });

  test("says something when the network never answers", async ({ page }) => {
    await page.route("**/forecast", (route) => route.abort("connectionfailed"));

    await page.goto(BASE);
    await page.fill("#ask", "Cebu");
    await page.click("#go");

    // Whatever the wording, the page must not sit silently on a dead request.
    await expect(page.locator("#result .err")).toBeVisible();
    await expect(page.locator("#go")).toBeEnabled();
  });

  test("a route that fails leaves the form usable", async ({ page }) => {
    await page.route("**/api/route", (route) =>
      route.fulfill({ status: 400, json: { error: "no place found for to: \"zzzqqq\"" } }));

    await page.goto(BASE);
    await page.click("#routego");
    await expect(page.locator("#routeresult .err")).toContainText("no place found");
    await expect(page.locator("#routego")).toBeEnabled();
    await expect(page.locator("#routeresult .leg")).toHaveCount(0, { timeout: 5000 });
  });

  test("the ledger says so when the chain cannot be read", async ({ page }) => {
    await page.route("**/api/policies", (route) => route.fulfill({ status: 502, json: { error: "rpc down" } }));
    await page.route("**/api/book", (route) => route.fulfill({ status: 502, json: { error: "rpc down" } }));

    await page.goto(BASE);
    // An empty table with no explanation reads as "no policies", which is a
    // different and much worse claim than "we could not look".
    await expect(page.locator("#ledgerbody")).toContainText(/unreachable|could not|unavailable/i);
  });
});

test.describe("navigation and entry points @ui", () => {
  test("a deep link lands on the section it names", async ({ page }) => {
    await page.goto(`${BASE}/#route`);
    const section = page.locator("#route");
    await expect(section).toBeVisible();

    // In view, not merely present in the document.
    const onScreen = await section.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    expect(onScreen, "#route must actually be scrolled into view").toBe(true);
  });

  test("the back button returns to where it came from", async ({ page }) => {
    await page.goto(BASE);
    await page.click('a[href="#route"]');
    await expect(page).toHaveURL(/#route$/);

    await page.goBack();
    await expect(page).not.toHaveURL(/#route$/);
  });

  test("a reload mid-request leaves the page usable, not half-drawn", async ({ page }) => {
    await page.route("**/forecast", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({ json: FORECAST });
    });

    await page.goto(BASE);
    await page.fill("#ask", "Cebu");
    await page.click("#go");
    await expect(page.locator("#go")).toBeDisabled();

    await page.reload();
    // A fresh load must not inherit the busy control from the abandoned request.
    await expect(page.locator("#go")).toBeEnabled();
    await expect(page.locator("#go")).toHaveText("Read the risk");
    await expect(page.locator("#result")).not.toHaveClass(/shown/);
  });
});

test.describe("forms refuse what they cannot answer @ui", () => {
  for (const [name, value] of [
    ["an empty field", ""],
    ["only spaces", "   "],
    ["punctuation", "!!!"],
  ]) {
    test(`refuses ${name} and says why`, async ({ page }) => {
      await page.goto(BASE);
      await page.fill("#ask", value);
      await page.click("#go");

      await expect(page.locator("#result .err")).toBeVisible();
      await expect(page.locator("#result .summary")).toHaveCount(0);
      await expect(page.locator("#go")).toBeEnabled();
    });
  }

  test("a very long input is refused rather than sent whole", async ({ page }) => {
    await page.goto(BASE);
    await page.fill("#ask", "Cebu ".repeat(4000));
    await page.click("#go");

    // Either the miner refuses it or the page does, but the page must not hang
    // and must not claim an answer.
    await expect(page.locator("#result")).toHaveClass(/shown/, { timeout: 40_000 });
    await expect(page.locator("#go")).toBeEnabled();
  });

  test("unicode and right-to-left text are handled, not mangled", async ({ page }) => {
    await page.goto(BASE);
    await page.fill("#ask", "الرياض");
    await page.click("#go");
    await expect(page.locator("#result")).toHaveClass(/shown/, { timeout: 40_000 });
    await expect(page.locator("#go")).toBeEnabled();
  });
});

test.describe("the board can go stale, and must say so @ui", () => {
  const lanes = (generated_at) => ({
    generated_at,
    rail: "paid (Telegraph Engine, verified)",
    trigger: 0.75,
    lanes: [
      { name: "Cebu → Manila", worst: { risk: 0.42, eta_hours: 15, lat: 14.6, lon: 121 }, legs: [], breach: false },
      { name: "Singapore → Jakarta", worst: { risk: 0.28, eta_hours: 12, lat: -6, lon: 106 }, legs: [], breach: false },
    ],
    telegraph: { calls: 6, spent_usd: 0.06, routed: 6, schema_fallback: 0 },
  });

  test("a fresh board reads as a plain timestamp", async ({ page }) => {
    await page.route("**/api/board", (route) =>
      route.fulfill({ json: lanes(new Date(Date.now() - 3600e3).toISOString()) }));

    await page.goto(BASE);
    await expect(page.locator("#plotstamp")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    await expect(page.locator("#plotstamp")).not.toHaveClass(/stale/);
  });

  // The schedule writes every twelve hours. If it stops — a missing secret, a
  // disabled workflow — the board keeps serving the last run forever, and a
  // storm reading from two days ago shown as current is worse than none.
  test("a board older than the schedule says so, in the colour that means trouble", async ({ page }) => {
    await page.route("**/api/board", (route) =>
      route.fulfill({ json: lanes(new Date(Date.now() - 48 * 3600e3).toISOString()) }));

    await page.goto(BASE);
    await expect(page.locator("#plotstamp")).toContainText("stale");
    await expect(page.locator("#plotstamp")).toHaveClass(/stale/);
    // and it still draws the lanes: stale is not the same as absent
    expect(await page.locator("#plot .reading").count()).toBe(2);
  });

  test("no board at all draws nothing and says why", async ({ page }) => {
    await page.route("**/api/board", (route) =>
      route.fulfill({ status: 503, json: { error: "the board has not been published yet" } }));

    await page.goto(BASE);
    await expect(page.locator("#plot .err")).toContainText("not been published");
    expect(await page.locator("#plot .reading").count()).toBe(0);
    await expect(page.locator("#plotstamp")).toHaveText("no board published");
  });
});
