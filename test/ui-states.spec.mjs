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

  // The schedule writes every six hours. If it stops — a missing secret, a
  // disabled workflow, a run that pays for nothing — the board keeps serving the
  // last run forever, and a storm reading from two days ago shown as current is
  // worse than none.
  test("a board older than the schedule says so, in the colour that means trouble", async ({ page }) => {
    await page.route("**/api/board", (route) =>
      route.fulfill({ json: lanes(new Date(Date.now() - 48 * 3600e3).toISOString()) }));

    await page.goto(BASE);
    await expect(page.locator("#plotstamp")).toContainText("stale");
    await expect(page.locator("#plotstamp")).toHaveClass(/stale/);
    // and it still draws the lanes: stale is not the same as absent
    expect(await page.locator("#plot .reading").count()).toBe(2);
  });

  // The boundary, because the boundary is what actually broke. The threshold
  // was 26 hours from the twelve-hourly schedule and nothing moved it when the
  // board went six-hourly, so four consecutive failed runs read as current.
  // Fourteen hours is two missed runs.
  test("two missed runs is stale, one late run is not", async ({ page }) => {
    await page.route("**/api/board", (route) =>
      route.fulfill({ json: lanes(new Date(Date.now() - 14 * 3600e3).toISOString()) }));
    await page.goto(BASE);
    await expect(page.locator("#plotstamp")).toHaveClass(/stale/);

    await page.route("**/api/board", (route) =>
      route.fulfill({ json: lanes(new Date(Date.now() - 7 * 3600e3).toISOString()) }));
    await page.goto(BASE);
    await expect(page.locator("#plotstamp")).not.toHaveClass(/stale/);
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

test.describe("the scoring board says which number is which @ui", () => {
  // Two intents, chosen to exercise the two things the table exists to show:
  // a published score that no longer describes the incumbent, and a live score
  // too small to survive fixed-point rounding.
  const SURVEY = {
    read_at: "2026-08-27T04:29:33.141Z",
    node: "https://devnode.telegraphprotocol.com",
    registrations: 1180,
    held: [["0xaaa", 43], ["0x39d2bae5", 1]],
    rows: [
      {
        intent: "CRYPTO_PRICE",
        champion: { eval: 0.9598, bar: 0.6729, attempts: 56, registration: 222, author: "0xaaa" },
        live: { scored: 9, nonzero: 7, best: 1.37e-8 },
      },
      {
        intent: "GAME_RESULT",
        champion: { eval: 0.7008, bar: 0.7008, attempts: 5, registration: 1253, author: "0x39d2bae5" },
        live: { scored: 2, nonzero: 2, best: 0.016917 },
      },
    ],
  };

  test("a live score below a ten-thousandth keeps its magnitude", async ({ page }) => {
    await page.route("**/api/survey", (route) => route.fulfill({ status: 200, json: SURVEY }));
    await page.goto(BASE);

    // 1.37e-8 rendered as a fixed-point number is "0.0000", which reads as
    // "roughly zero" when the point is that it is eight orders below the prose
    // intents. The exponent is the finding.
    const row = page.locator("#surveybody tr", { hasText: "CRYPTO_PRICE" });
    await expect(row).toContainText(/e-8/);
  });

  test("a published score that no longer describes the champion is marked", async ({ page }) => {
    await page.route("**/api/survey", (route) => route.fulfill({ status: 200, json: SURVEY }));
    await page.goto(BASE);

    // CRYPTO_PRICE is off by 0.29 and must be flagged; GAME_RESULT's two
    // numbers agree exactly and must not be, or the mark means nothing.
    const off = page.locator("#surveybody tr", { hasText: "CRYPTO_PRICE" }).locator("td[style*='trigger']");
    await expect(off).toHaveCount(1);

    const fine = page.locator("#surveybody tr", { hasText: "GAME_RESULT" }).locator("td[style*='trigger']");
    await expect(fine).toHaveCount(0);
  });

  test("no survey published draws nothing and says why", async ({ page }) => {
    await page.route("**/api/survey", (route) =>
      route.fulfill({ status: 503, json: { error: "the survey has not been published yet" } }));

    await page.goto(BASE);
    // An empty table reads as "the network scores nothing", which is a claim
    // this page must not make by accident.
    await expect(page.locator("#surveybody")).toContainText("not been published");
  });
});

test.describe("the reading shows the sea and the storm when there are any @ui", () => {
  const reading = (over) => ({
    summary: "Storm risk at 13.60, -38.70: 26.6 °C with wind 38.2 km/h, gusts 50.4 km/h and 1.4 mm precipitation, valid at 2026-08-27T21:00Z. Waves 2.7 m. Tropical cyclone DOLLY-26 (74 km/h, Green) is 0 km away now. Storm risk is elevated (0.685).",
    place: null, lat: 13.6, lon: -38.7, hours: 6, condition: "Slight rain showers", weather_code: 80,
    temp_min_c: 24.8, temp_max_c: 27.5, temp_c: 26.6, wind_kmh: 38.2, gust_kmh: 50.4, precip_mm: 1.4,
    wave_m: 2.74, cyclone_name: "DOLLY-26", cyclone_km_now: 0, cyclone_max_wind_kmh: 74, cyclone_alert: "Green",
    risk: 0.685, breach: false, valid_at: "2026-08-27T21:00Z", source: "open-meteo",
    ...over,
  });

  test("a point under a named storm shows its waves and the storm by name", async ({ page }) => {
    await page.route("**/forecast*", (route) => route.fulfill({ status: 200, json: reading() }));
    await page.goto(BASE);
    await page.fill("#ask", "13.60, -38.70");
    await page.click("#go");
    const figures = page.locator("#result .figures");
    await expect(figures).toContainText("waves");
    await expect(figures).toContainText("2.7 m");
    await expect(figures).toContainText("DOLLY-26");
    await expect(figures).toContainText("74 km/h");
  });

  test("an inland point shows neither, rather than a dash", async ({ page }) => {
    await page.route("**/forecast*", (route) =>
      route.fulfill({ status: 200, json: reading({ wave_m: null, cyclone_name: null, cyclone_km_now: null, cyclone_max_wind_kmh: null, cyclone_alert: null }) }));
    await page.goto(BASE);
    await page.fill("#ask", "24.69, 46.72");
    await page.click("#go");
    const figures = page.locator("#result .figures");
    await expect(figures).toContainText("temperature");
    await expect(figures).not.toContainText("waves");
    await expect(figures).not.toContainText("cyclone");
  });
});

test.describe("the backtest says where the cover would have paid @ui", () => {
  const run = (breach) => ({
    lat: 0, lon: 0, start: "2021-12-15", end: "2021-12-18", trigger: 0.75, hours: 96,
    peak: { at: breach ? "2021-12-16T13:00Z" : "2021-12-17T07:00Z", risk: breach ? 1 : 0.568, wind_kmh: breach ? 90.7 : 17.7, gust_kmh: breach ? 170.6 : 51.1, precip_mm: 0 },
    breach, hours_above_trigger: breach ? 13 : 0, series: [], source: "test",
  });

  test("a port the storm crossed pays, one it missed does not", async ({ page }) => {
    await page.route("**/api/backtest*", (route) => {
      const u = new URL(route.request().url());
      return route.fulfill({ status: 200, json: run(u.searchParams.get("lat") === "10.32") });
    });
    await page.goto(BASE);
    const rows = page.locator("#backtestbody tr");
    await expect(rows).toHaveCount(5);
    const cebu = rows.filter({ hasText: "Cebu" });
    await expect(cebu).toContainText("1.000");
    await expect(cebu).toContainText("171 km/h");
    await expect(cebu.locator(".tag")).toHaveText("pays");
    const manila = rows.filter({ hasText: "Manila" });
    await expect(manila.locator(".tag")).toHaveText("no claim");
    await expect(page.locator("#backteststat")).toContainText("pays at Cebu");
  });

  test("an archive that cannot be read says so per port", async ({ page }) => {
    await page.route("**/api/backtest*", (route) => route.fulfill({ status: 502, json: { error: "archive down" } }));
    await page.goto(BASE);
    await expect(page.locator("#backtestbody")).toContainText("could not read the archive");
    await expect(page.locator("#backtestbody tr")).toHaveCount(5);
  });

  test("the reading shows its band and its signature", async ({ page }) => {
    await page.route("**/forecast*", (route) => route.fulfill({ status: 200, json: {
      summary: "Storm risk at 10.32, 123.89: 27.1 °C, wind 11.4 km/h, valid at 2026-08-28T09:00Z. Storm risk is low (0.332); across 51 ensemble runs it ranges 0.30 to 0.45, 2% of them over the trigger.",
      lat: 10.32, lon: 123.89, hours: 6, temp_c: 27.1, wind_kmh: 11.4, gust_kmh: 29.9, precip_mm: 0, condition: "Overcast",
      risk: 0.332, breach: false, valid_at: "2026-08-28T09:00Z", wave_m: null, cyclone_name: null,
      risk_band: { model: "ecmwf_ifs025", members: 51, p10: 0.3, p50: 0.36, p90: 0.45, max: 0.8, breach_probability: 0.02 },
      attestation: { algorithm: "ed25519", public_key: "MCowBQYDK2VwAyEAabcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=", key_persistent: true, canonical: "{}", signature: "x", sha256: "y", signed_fields: [] },
    } }));
    await page.goto(BASE);
    await page.fill("#ask", "10.32, 123.89");
    await page.click("#go");
    const figures = page.locator("#result .figures");
    await expect(figures).toContainText("51 runs");
    await expect(figures).toContainText("0.30–0.45");
    await expect(figures).toContainText("2% pay");
    await expect(figures).toContainText("ed25519");
    await expect(figures).not.toContainText("ephemeral");
  });
});

test.describe("every reading is a URL @ui", () => {
  const READING = { ...FORECAST, summary: "Storm risk in Cebu: 29.0 °C, wind 10.7 km/h. Storm risk is low (0.252).", risk: 0.252 };

  test("a reading arrived by URL runs on load, and the address follows a new one", async ({ page }) => {
    let asked = [];
    await page.route("**/forecast", (route) => { asked.push((route.request().postDataJSON() ?? {}).question); return route.fulfill({ json: READING }); });
    await page.goto(BASE + "/?q=Cebu");
    await expect(page.locator("#result .summary")).toBeVisible();
    expect(asked).toContain("Cebu");
    expect(await page.locator("#ask").inputValue()).toBe("Cebu");

    // A new question rewrites the address only once its answer has landed.
    await page.fill("#ask", "Manila");
    await page.click("#go");
    await expect(page.locator("#result .summary")).toBeVisible();
    await expect(page).toHaveURL(/q=Manila/);

    // And the back button retraces the trail: the previous reading returns.
    await page.goBack();
    await expect(page).toHaveURL(/q=Cebu/);
    await expect(page.locator("#ask")).toHaveValue("Cebu");
  });

  test("a failed reading leaves the address alone", async ({ page }) => {
    await page.route("**/forecast", (route) => route.fulfill({ status: 400, json: { error: "no place found" } }));
    await page.goto(BASE);
    await page.fill("#ask", "zzzqqq");
    await page.click("#go");
    await expect(page.locator("#result .err")).toBeVisible();
    await expect(page).not.toHaveURL(/q=/);
  });
});

test.describe("the replay respects motion preferences @ui", () => {
  const series = Array.from({ length: 10 }, (_, i) => ({ at: `2021-12-16T${String(i).padStart(2, "0")}:00Z`, risk: i === 6 ? 1 : 0.2 }));
  const run = { lat: 10.32, lon: 123.89, start: "2021-12-15", end: "2021-12-18", trigger: 0.75, hours: 10, peak: { at: "2021-12-16T06:00Z", risk: 1, wind_kmh: 90, gust_kmh: 170, precip_mm: 12 }, breach: true, hours_above_trigger: 1, series, source: "test" };

  test("with reduced motion the needle rests on the peak hour", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/backtest*", (route) => route.fulfill({ status: 200, json: run }));
    await page.goto(BASE);
    await expect(page.locator("#replay")).toBeVisible();
    await expect(page.locator("#replayval")).toHaveText("1.000");
    await expect(page.locator("#replayclock")).toContainText("16 Dec 06:00 UTC");
  });

  test("with motion the needle advances through the hours once in view", async ({ page }) => {
    await page.route("**/api/backtest*", (route) => route.fulfill({ status: 200, json: run }));
    await page.goto(BASE);
    await page.locator("#replay").scrollIntoViewIfNeeded();
    // Ten steps at 70 ms: the replay ends on the last hour within a second.
    await expect(page.locator("#replayclock")).toContainText("16 Dec 09:00 UTC", { timeout: 5000 });
  });
});
