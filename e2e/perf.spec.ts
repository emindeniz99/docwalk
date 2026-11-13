import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CORS } from "./helpers";

/**
 * Decision 43's budgets, checked on the production build the way a visitor
 * gets it.
 *
 * Size: `pnpm size` counts the files index.html and App's preload list name,
 * which misses what the default view fetches next (the editor chunk, Mermaid
 * and its diagram types). This spec sums what the browser really downloads.
 *
 * Time: shared CI runners are slower and noisier than a laptop, so a time
 * fails only above TIME_MARGIN times its budget; above the budget itself the
 * test passes with a warning annotation. The margin catches a several-fold
 * regression (an O(n²) pagination, a heavy chunk on the critical path), not a
 * few percent. The timings run on Chromium only: the budget is a regression
 * alarm, not an engine comparison, and one engine keeps the noise down.
 */

const SIZE_LIMIT = 5_000_000; // bytes, gzip; the hard limit in .size-limit.ts
const SIZE_WARN = 3_000_000; // tooling/size-check.ts's warning line
const OPEN_BUDGET_MS = 1500;
const REPAGINATE_BUDGET_MS = 300;
const TIME_MARGIN = 3;
// The deck waits this long after the last keystroke before it rebuilds
// (REBUILD_DELAY_MS in src/deck/Deck.tsx), so typing does not rebuild on
// every key. The 300 ms budget covers the rebuild itself, after that pause.
const REBUILD_DELAY_MS = 250;

// 809 lines with 14 Mermaid diagrams: heavier than the 500-line document the
// budget names, so passing here passes there.
const FIXTURE = readFileSync(new URL("../fixtures/ledger-redesign.md", import.meta.url), "utf8");
const RAW = "https://raw.githubusercontent.com/acme/docs/main/ledger-redesign.md";

test.skip(({ browserName }) => browserName !== "chromium", "budgets are measured on Chromium");

/** Records `value` against its budget, warning above it; returns the failing limit. */
function budget(info: TestInfo, name: string, value: number, target: number, unit: string) {
  const line = `${name}: ${Math.round(value)} ${unit} (budget ${target} ${unit})`;
  console.log(line);
  if (value > target) {
    info.annotations.push({ type: "warning", description: `${line}, over budget` });
    if (process.env["GITHUB_ACTIONS"]) console.log(`::warning::${line}, over budget`);
  }
}

/** The page clock (ms since navigation started) once the status bar reports more than `after` slides. */
async function slidesReported(page: Page, after = 0): Promise<{ at: number; slides: number }> {
  const handle = await page.waitForFunction(
    (min) => {
      const text = document.querySelector(".docwalk-statusbar")?.textContent ?? "";
      const count = Number(/(\d+) slides?/.exec(text)?.[1] ?? 0);
      return count > min ? { at: performance.now(), slides: count } : null;
    },
    after,
    { timeout: 30_000 },
  );
  return handle.jsonValue() as Promise<{ at: number; slides: number }>;
}

async function openFixture(page: Page) {
  await page.route(RAW, (route) =>
    route.fulfill({ contentType: "text/plain; charset=utf-8", headers: CORS, body: FIXTURE }),
  );
  await page.goto(`/?src=${encodeURIComponent(RAW)}`);
  return slidesReported(page);
}

test("the default view downloads less than decision 124's 5 MB of JS and CSS (gzip)", async ({
  page,
}, info) => {
  // A fresh context has an empty HTTP cache and the config blocks the
  // service worker, so this is a first visit: the sample deck in the edit view.
  const origin = new URL(info.project.use.baseURL ?? "http://localhost").origin;
  const bodies: Promise<{ url: string; gzip: number }>[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    if (!/\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname)) return;
    bodies.push(
      response
        .body()
        .then((body) => ({ url: url.pathname, gzip: gzipSync(body, { level: 9 }).length })),
    );
  });
  await page.goto("/");
  await slidesReported(page);
  // The editor chunk loads beside the deck and may finish after it.
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const files = await Promise.all(bodies);
  const total = files.reduce((sum, file) => sum + file.gzip, 0);
  for (const file of files.toSorted((a, b) => b.gzip - a.gzip).slice(0, 8))
    console.log(`  ${(file.gzip / 1000).toFixed(1)} kB  ${file.url}`);
  budget(info, `First load, ${files.length} files`, total / 1000, SIZE_WARN / 1000, "kB");
  // Sign-in code is for a callback or a session to keep fresh, never for /api/health (decision 126).
  expect(
    files.map((file) => file.url).filter((url) => /\/oauth-[^/]+\.js$/.test(url)),
    "sign-in chunks in the first load",
  ).toEqual([]);
  expect(total, "gzip bytes of same-origin JS and CSS").toBeLessThanOrEqual(SIZE_LIMIT);
});

test("the fixture opens ready to present within decision 43's 1.5 s", async ({ page }, info) => {
  // Measured from navigation start, so it covers loading the app, fetching
  // the document, rendering every diagram and paginating.
  const { at } = await openFixture(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator("[data-view='present']")).toBeVisible();
  const presented = await page.evaluate(() => performance.now());
  budget(info, "Open the fixture in presentation mode", presented, OPEN_BUDGET_MS, "ms");
  expect(at, "status bar reported the slides").toBeGreaterThan(0);
  expect(presented).toBeLessThan(OPEN_BUDGET_MS * TIME_MARGIN);
});

test("an edit to the fixture repaginates within decision 43's 300 ms", async ({ page }, info) => {
  const { slides } = await openFixture(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  // One input event, like a paste: the edit ends the moment it lands.
  await page.keyboard.insertText("\n\n## Timing probe\n\nA new section adds a slide.\n");
  const typed = await page.evaluate(() => performance.now());
  const { at } = await slidesReported(page, slides);
  const rebuild = at - typed - REBUILD_DELAY_MS;
  budget(info, "Repaginate after an edit", rebuild, REPAGINATE_BUDGET_MS, "ms");
  expect(rebuild).toBeLessThan(REPAGINATE_BUDGET_MS * TIME_MARGIN);
});
