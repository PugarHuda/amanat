// End-to-end tests against a running Amanat miner.
//
//   npm run test:e2e                    # against the local server
//   E2E_BASE=https://amanat-miner.vercel.app npm run test:e2e
//
// These hit the real upstream and the real chain. That is the point: the miner's
// job is to answer correctly about the actual weather, and the page's claim is
// that its ledger is read from Base rather than typed in. A suite that mocked
// either would test the mocks.
//
// The consequence is that a network failure fails the suite. That is the honest
// trade — a green run here means the deployed thing worked, not that a fixture
// did.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8799";

const CEBU = { lat: 10.32, lon: 123.89 };

test.describe("miner API — happy paths", () => {
  test("answers a valid forecast request", async ({ request }) => {
    const res = await request.post(`${BASE}/forecast`, { data: { ...CEBU, hours: 1 } });
    expect(res.status()).toBe(200);
    const body = await res.json();

    for (const key of ["summary", "temp_c", "wind_kmh", "gust_kmh", "precip_mm", "risk", "breach", "valid_at", "source",
                       "condition", "weather_code", "temp_min_c", "temp_max_c"]) {
      expect(body, `response is missing ${key}`).toHaveProperty(key);
    }
    expect(body.risk).toBeGreaterThanOrEqual(0);
    expect(body.risk).toBeLessThanOrEqual(1);
    expect(typeof body.breach).toBe("boolean");
    expect(body.breach).toBe(body.risk >= 0.75);
    // The sentence and the scalars have to agree — they are one answer in two
    // shapes, and a scorer grades the sentence while a contract acts on the
    // scalars.
    expect(body.summary).toContain(body.temp_c.toFixed(1));
    expect(body.summary).toContain(body.risk.toFixed(3));
  });

  test("accepts coordinates as query parameters too", async ({ request }) => {
    const res = await request.get(`${BASE}/forecast?lat=${CEBU.lat}&lon=${CEBU.lon}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).risk).toBeGreaterThanOrEqual(0);
  });

  test("forecasts a time in the future, not one already past", async ({ request }) => {
    const res = await request.post(`${BASE}/forecast`, { data: { ...CEBU, hours: 3 } });
    const { valid_at } = await res.json();
    const at = Date.parse(valid_at);
    expect(at).toBeGreaterThan(Date.now() - 3600e3);
    expect(Math.abs(at - (Date.now() + 3 * 3600e3))).toBeLessThanOrEqual(3600e3);
  });

  // A list of scalars does not answer "what is the weather". A condition word
  // and a daily range do, and they are what the answers that score carry.
  test("names the condition and the day range", async ({ request }) => {
    const res = await request.post(`${BASE}/forecast`, { data: { ...CEBU, hours: 6 } });
    const body = await res.json();

    expect(typeof body.condition).toBe("string");
    expect(body.condition.length).toBeGreaterThan(2);
    expect(body.temp_min_c).toBeLessThanOrEqual(body.temp_max_c);
    expect(body.summary.startsWith(body.valid_at.slice(0, 10))).toBe(true);
    expect(body.summary).toContain(body.condition);
    // and the scalars a contract settles on are still all there
    expect(body.summary).toContain(body.risk.toFixed(3));
  });

  test("reports health as itself", async ({ request }) => {
    const res = await request.get(`${BASE}/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", miner: "amanat" });
  });

  test("reads the book from chain", async ({ request }) => {
    const res = await request.get(`${BASE}/api/book`);
    expect(res.status()).toBe(200);
    const book = await res.json();
    expect(book.contract).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(book.policies).toBeGreaterThanOrEqual(0);
    expect(Number(book.jobBudget)).not.toBeNaN();
  });

  test("reads policies from chain, newest first", async ({ request }) => {
    const res = await request.get(`${BASE}/api/policies`);
    expect(res.status()).toBe(200);
    const { total, rows, unreadable } = await res.json();
    expect(total).toBeGreaterThanOrEqual(rows.length);
    expect(unreadable).toBe(0);

    if (rows.length > 1) {
      expect(rows[0].id).toBeGreaterThan(rows[1].id);
    }
    for (const p of rows) {
      expect(p.holder).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(["None", "Active", "Claimed", "Declined", "Expired"]).toContain(p.status);
      // Coordinates round-trip as the strings the contract stores.
      expect(Number(p.lat)).not.toBeNaN();
      expect(Number(p.lon)).not.toBeNaN();
    }
  });
});

test.describe("miner API — failure paths", () => {
  // Absent is not zero. Every one of these answered 200 with a confident
  // forecast for Null Island before the miner started refusing them.
  for (const [name, data] of [
    ["empty body", {}],
    ["missing lat", { lon: 10 }],
    ["missing lon", { lat: 10 }],
    ["null coordinates", { lat: null, lon: null }],
    ["empty-string coordinates", { lat: "", lon: "" }],
  ]) {
    test(`refuses ${name}`, async ({ request }) => {
      const res = await request.post(`${BASE}/forecast`, { data });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(/required/);
    });
  }

  for (const [name, data, pattern] of [
    ["latitude above 90", { lat: 999, lon: 0 }, /lat must be between/],
    ["latitude below -90", { lat: -999, lon: 0 }, /lat must be between/],
    ["longitude above 180", { lat: 0, lon: 999 }, /lon must be between/],
    ["non-numeric coordinates", { lat: "abc", lon: "def" }, /lat must be between/],
    ["negative hours", { ...CEBU, hours: -5 }, /hours must be/],
    ["hours beyond the forecast window", { ...CEBU, hours: 9999 }, /hours must be/],
    ["fractional hours", { ...CEBU, hours: 1.5 }, /hours must be/],
  ]) {
    test(`refuses ${name}`, async ({ request }) => {
      const res = await request.post(`${BASE}/forecast`, { data });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(pattern);
    });
  }

  test("accepts the boundary coordinates themselves", async ({ request }) => {
    for (const data of [{ lat: 90, lon: 0 }, { lat: -90, lon: 0 }, { lat: 0, lon: 180 }, { lat: 0, lon: -180 }]) {
      const res = await request.post(`${BASE}/forecast`, { data });
      expect(res.status(), `${JSON.stringify(data)} is a real place`).toBe(200);
    }
  });

  test("refuses a body larger than the declared limit", async ({ request }) => {
    const res = await request.post(`${BASE}/forecast`, {
      data: { ...CEBU, padding: "x".repeat(70_000) },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });

  test("404s an unknown route and names the ones that exist", async ({ request }) => {
    const res = await request.get(`${BASE}/nope`);
    expect(res.status()).toBe(404);
    expect((await res.json()).endpoints).toContain("/forecast");
  });
});

test.describe("miner API — plain-language questions", () => {
  // Validators run an epoch tournament that puts one sentence to every miner on
  // an intent. Answering only coordinate pairs scored zero on three intents at
  // epoch 276 while 296 direct requests were being served correctly.
  for (const [question, expected] of [
    ["Will Riyadh exceed 40 degrees in the next 24 hours?", /Riyadh/],
    ["What is the storm risk at 10.32, 123.89 in the next six hours?", /10\.32, 123\.89/],
    ["Is there a severe weather warning for Manila today?", /Manila/],
    ["How much rain will fall in Jakarta tonight?", /Jakarta/],
    ["What is the weather in New York City?", /New York/],
  ]) {
    test(`answers: ${question}`, async ({ request }) => {
      const res = await request.post(`${BASE}/forecast`, { data: { question } });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();

      expect(body.summary, "must name where it answered about").toMatch(expected);
      expect(body.summary).toMatch(/Storm risk is (low|elevated|severe)/);
      expect(body.risk).toBeGreaterThanOrEqual(0);
      expect(body.risk).toBeLessThanOrEqual(1);
      expect(Date.parse(body.valid_at)).toBeGreaterThan(Date.now() - 3600e3);
    });
  }

  test("reads the hour offset out of the question", async ({ request }) => {
    const soon = await request.post(`${BASE}/forecast`, { data: { question: "Storm risk in Cebu right now?" } });
    const later = await request.post(`${BASE}/forecast`, { data: { question: "Storm risk in Cebu in 48 hours?" } });
    expect(soon.status()).toBe(200);
    expect(later.status()).toBe(200);

    const gap = Date.parse((await later.json()).valid_at) - Date.parse((await soon.json()).valid_at);
    expect(gap, "48 hours must land two days out").toBe(48 * 3600e3);
  });

  test("takes the question under any of the field names callers use", async ({ request }) => {
    for (const field of ["question", "q", "query", "prompt", "text", "input", "place", "location", "city"]) {
      const res = await request.post(`${BASE}/forecast`, { data: { [field]: "weather in Rotterdam" } });
      expect(res.status(), `${field} must be accepted`).toBe(200);
      expect((await res.json()).summary).toMatch(/Rotterdam/);
    }
  });

  test("explicit coordinates win over any question in the same body", async ({ request }) => {
    const res = await request.post(`${BASE}/forecast`, { data: { ...CEBU, question: "weather in Reykjavik" } });
    expect(res.status()).toBe(200);
    expect((await res.json()).summary).toMatch(/10\.32, 123\.89/);
  });

  // Answering about an invented place is worse than refusing: a contract that
  // settles on the reading would settle on the wrong one.
  for (const [name, question] of [
    ["a question naming no place", "Will it storm?"],
    ["nonsense", "zzzqqq wibble"],
    ["whitespace", "   "],
  ]) {
    test(`refuses ${name}`, async ({ request }) => {
      const res = await request.post(`${BASE}/forecast`, { data: { question } });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(/no place found|required/);
    });
  }
});

test.describe("the page @ui", () => {
  test("loads and names itself", async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle(/Amanat/);
    await expect(page.locator("h1")).toContainText("One reading, one line");
  });

  test("plots live readings against the trigger line", async ({ page }) => {
    await page.goto(BASE);
    const readings = page.locator(".reading");
    await expect(readings.first()).toBeVisible({ timeout: 30_000 });
    await expect(readings).toHaveCount(5, { timeout: 60_000 });

    for (const value of await page.locator(".reading .val").allTextContents()) {
      const risk = Number(value);
      expect(risk).toBeGreaterThanOrEqual(0);
      expect(risk).toBeLessThanOrEqual(1);
    }
    // A dot is marked over only when it actually is.
    for (const el of await page.locator(".reading").all()) {
      const risk = Number(await el.locator(".val").textContent());
      const over = (await el.getAttribute("class")).includes("over");
      expect(over, `${risk} marked over=${over}`).toBe(risk >= 0.75);
    }
  });

  test("checks a coordinate pair and shows the reading", async ({ page }) => {
    await page.goto(BASE);
    await page.fill("#ask", "14.60, 120.98");
    await page.click("#go");

    const result = page.locator("#result");
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.locator(".num")).toHaveText(/^\d\.\d{3}$/);
    await expect(result.locator(".summary")).toContainText("forecast for 14.60, 120.98");
    await expect(result.locator(".figures")).toContainText("temperature");
  });

  // One field, both forms — the page can only offer this because the miner
  // accepts both, so the test is the claim.
  test("takes a place name in the same field", async ({ page }) => {
    await page.goto(BASE);
    await page.fill("#ask", "Rotterdam");
    await page.click("#go");
    await expect(page.locator("#result .summary")).toContainText("Rotterdam", { timeout: 30_000 });
  });

  test("takes a whole question in the same field", async ({ page }) => {
    await page.goto(BASE);
    await page.fill("#ask", "Will Riyadh exceed 40 degrees tomorrow?");
    await page.click("#go");
    await expect(page.locator("#result .summary")).toContainText("Riyadh", { timeout: 30_000 });
  });

  test("a preset fills the form and runs it", async ({ page }) => {
    await page.goto(BASE);
    await page.click('#presets button[data-ask="Hong Kong"]');
    await expect(page.locator("#ask")).toHaveValue("Hong Kong");
    await expect(page.locator("#result .summary")).toContainText("Hong Kong", { timeout: 30_000 });
  });

  test("shows the miner's own message when nothing in the text is a place", async ({ page }) => {
    await page.goto(BASE);
    await page.fill("#ask", "zzzqqq wibble");
    await page.click("#go");
    await expect(page.locator("#result .err")).toContainText("no place found", { timeout: 30_000 });
    // The button has to come back, or one bad input ends the session.
    await expect(page.locator("#go")).toBeEnabled();
    await expect(page.locator("#go")).toHaveText("Read the risk");
  });

  test("renders the ledger from chain, not from markup", async ({ page }) => {
    await page.goto(BASE);
    const rows = page.locator("#ledgerbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#ledgerbody")).not.toContainText("reading the chain…", { timeout: 30_000 });

    const api = await (await page.request.get(`${BASE}/api/policies`)).json();
    await expect(rows).toHaveCount(api.rows.length + (api.unreadable ? 1 : 0));
    if (api.rows.length) {
      await expect(rows.first()).toContainText(String(api.rows[0].id));
      await expect(rows.first()).toContainText(api.rows[0].lat);
    }
  });

  test("reports the book on chain", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#bookstat")).toContainText(/policies written/, { timeout: 30_000 });
  });

  test("cannot be injected through chain data", async ({ page }) => {
    await page.goto(BASE);

    // Drive the page's own element builder — the one the ledger and the result
    // panel use — with a hostile string. Coordinates are written on-chain by
    // whoever opened the policy, so this is the shape of the real risk, and
    // testing a copy of the logic would prove nothing about the page.
    // eslint-env browser
    /* global el */
    const outcome = await page.evaluate(() => {
      window.__xss = false;
      const hostile = '<img src=x onerror="window.__xss=true">';
      const cell = el("td", { text: hostile });
      document.body.appendChild(cell);
      return {
        builderExists: typeof el === "function",
        createdElement: cell.querySelector("img") !== null,
        renderedAsText: cell.textContent === hostile,
        childIsText: cell.firstChild?.nodeType === Node.TEXT_NODE,
      };
    });

    expect(outcome.builderExists, "the page must build cells with el()").toBe(true);
    expect(outcome.createdElement, "hostile input must not become an element").toBe(false);
    expect(outcome.renderedAsText).toBe(true);
    expect(outcome.childIsText).toBe(true);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__xss)).toBe(false);
  });

  test("renders every ledger cell as text, never markup", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("#ledgerbody tr").first()).toBeVisible({ timeout: 30_000 });

    // Not one cell in the ledger may contain a child element: every value there
    // came off the chain, and an element means something was parsed as markup.
    const withElements = await page.evaluate(() =>
      [...document.querySelectorAll("#ledgerbody td")]
        .filter((td) => td.children.length && !td.querySelector(".tag"))
        .map((td) => td.innerHTML.slice(0, 60)));
    expect(withElements).toEqual([]);
  });

  test("logs nothing to the console", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.waitForTimeout(6000);
    expect(errors).toEqual([]);
  });

  test("fits a phone without clipping the navigation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the page must not scroll sideways").toBeLessThanOrEqual(1);

    for (const link of await page.locator("nav a").all()) {
      const box = await link.boundingBox();
      expect(box.x + box.width, `${await link.textContent()} runs off the screen`).toBeLessThanOrEqual(391);
    }
  });

  test("keyboard reaches the form and shows focus", async ({ page }) => {
    await page.goto(BASE);
    await page.locator("#ask").focus();
    const outline = await page.locator("#ask").evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
  });
});

test.describe("routes", () => {
  // Cargo is not exposed to the weather at the port it left. Each leg is
  // forecast for the hour the shipment reaches it, and the verdict is the worst
  // hour on the way rather than an average that hides it.
  test("forecasts each leg for the hour the cargo arrives", async ({ request }) => {
    const res = await request.post(`${BASE}/api/route`, { data: { from: "Cebu", to: "Manila", speed_kmh: 37, max_legs: 4 } });
    expect(res.status(), await res.text()).toBe(200);
    const r = await res.json();

    expect(r.legs).toHaveLength(4);
    expect(r.legs[0].eta_hours).toBe(0);
    expect(r.legs[3].eta_hours).toBeGreaterThan(0);
    expect(r.distance_km).toBeGreaterThan(400);
    expect(r.distance_km).toBeLessThan(750);

    for (let i = 1; i < r.legs.length; i++) {
      expect(r.legs[i].km_from_start).toBeGreaterThan(r.legs[i - 1].km_from_start);
      expect(r.legs[i].eta_hours).toBeGreaterThanOrEqual(r.legs[i - 1].eta_hours);
    }
    // Each leg is forecast for a different hour, so the timestamps must differ.
    // If they were all equal the route would be a weather report, not a risk
    // assessment, and the whole feature would be decoration.
    const stamps = new Set(r.legs.map((l) => l.valid_at));
    expect(stamps.size, "legs must not all be forecast for the same hour").toBeGreaterThan(1);

    expect(r.worst.risk).toBe(Math.max(...r.legs.map((l) => l.risk)));
    expect(r.breach).toBe(r.worst.risk >= 0.75);
  });

  test("a slower vehicle meets later weather", async ({ request }) => {
    const fast = await request.post(`${BASE}/api/route`, { data: { from: "Cebu", to: "Manila", speed_kmh: 80, max_legs: 3 } });
    const slow = await request.post(`${BASE}/api/route`, { data: { from: "Cebu", to: "Manila", speed_kmh: 20, max_legs: 3 } });
    const f = await fast.json();
    const s = await slow.json();
    expect(s.duration_hours).toBeGreaterThan(f.duration_hours);
    expect(s.legs[2].eta_hours).toBeGreaterThan(f.legs[2].eta_hours);
  });

  test("reports a leg beyond the forecast horizon instead of clamping it", async ({ request }) => {
    const res = await request.post(`${BASE}/api/route`, { data: { from: "Cebu", to: "Rotterdam", speed_kmh: 37, max_legs: 5 } });
    expect(res.status()).toBe(200);
    const r = await res.json();
    expect(r.duration_hours).toBeGreaterThan(168);

    const far = r.legs.filter((l) => l.beyond_horizon);
    expect(far.length).toBeGreaterThan(0);
    for (const leg of far) expect(leg.risk).toBeNull();
    expect(r.unread).toBeGreaterThan(0);
  });

  for (const [name, data, pattern] of [
    ["an empty request", {}, /from is required/],
    ["a route with no destination", { from: "Cebu" }, /to is required/],
    ["a destination that is nowhere", { from: "Cebu", to: "zzzqqq" }, /no place found for to/],
    ["an origin that is nowhere", { from: "zzzqqq", to: "Cebu" }, /no place found for from/],
    ["a stationary vehicle", { from: "Cebu", to: "Manila", speed_kmh: 0 }, /speed_kmh must be/],
  ]) {
    test(`refuses ${name}`, async ({ request }) => {
      const res = await request.post(`${BASE}/api/route`, { data });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(pattern);
    });
  }

  test("the page draws the route leg by leg @ui", async ({ page }) => {
    await page.goto(BASE);
    await page.click('#routepresets button[data-from="Cebu"]');
    await expect(page.locator("#routeresult .leg").first()).toBeVisible({ timeout: 45_000 });

    expect(await page.locator("#routeresult .leg").count()).toBeGreaterThan(2);
    await expect(page.locator("#routeresult .verdict .num")).toHaveText(/^\d\.\d{3}$/);
    await expect(page.locator("#routeresult .figures")).toContainText("distance");
  });

  test("says so when a route names nowhere, rather than drawing an empty one @ui", async ({ page }) => {
    await page.goto(BASE);
    await page.fill("#routeto", "zzzqqq");
    await page.click("#routego");
    await expect(page.locator("#routeresult .err")).toContainText("no place found", { timeout: 45_000 });
    await expect(page.locator("#routego")).toBeEnabled();
  });
});

test.describe("the registration YAML", () => {
  // Registration is terminal and costs a transaction. Registration 217 was
  // rejected with "YAML schema validation failed: []" — an empty list, because
  // a description carrying a comma and a question mark inside a { } flow
  // mapping stopped the file parsing at all. Nothing before this test read the
  // YAML with a parser, so every pre-flight check passed and the gas was spent.
  const doc = parseYaml(readFileSync(new URL("../miner/amanat-miner.yaml", import.meta.url), "utf8"));

  test("declares the endpoint the server actually serves", async ({ request }) => {
    expect(doc.endpoints.map((e) => e.path)).toContain("/forecast");
    expect(doc.endpoints.find((e) => e.path === "/forecast").method).toBe("POST");

    const res = await request.post(`${BASE}/forecast`, { data: { ...CEBU, hours: 1 } });
    expect(res.status()).toBe(200);
  });

  test("declares every input the server accepts, and demands none it cannot require", () => {
    expect(Object.keys(doc.input_schema.properties).sort()).toEqual(["hours", "lat", "lon", "question"]);
    for (const field of ["condition", "weather_code", "temp_min_c", "temp_max_c"]) {
      expect(Object.keys(doc.output_schema.properties), `output_schema must declare ${field}`).toContain(field);
    }
    // `required: [lat, lon]` makes a plain-language question unanswerable by
    // declaration, which is how three intents scored zero at epoch 276.
    expect(doc.input_schema.required, "one of two input forms is legal, so neither is required").toBeUndefined();
  });

  test("maps the answer field a validator grades", () => {
    expect(doc.semantics.signal_mapping.label_field).toBe("summary");
    expect(doc.semantics.supported_intents.length).toBeGreaterThan(0);
  });

  test("gives every on_chain field a description", () => {
    for (const field of Object.values(doc.on_chain.fields).flat()) {
      expect(field.description, `${field.name} needs a description or the registration is rejected`).toBeTruthy();
    }
  });
});
