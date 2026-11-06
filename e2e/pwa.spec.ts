import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { ready } from "./helpers";

/**
 * The installable, offline app (decision 11) against the production build.
 * A service worker's mistakes only show in a real browser across reloads:
 * a precache list that misses a chunk, an /api answer replayed from a cache,
 * an update that reloads under a presenter or never arrives.
 */

// The other specs block the worker (playwright.config.ts); this one tests it.
test.use({ serviceWorkers: "allow" });

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SHOTS = process.env["DOCWALK_SHOTS_DIR"];

/** Waits until the service worker controls the page. */
async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

/** Same-origin build assets this page loaded that no cache holds yet. */
const uncachedAssets = (page: Page) =>
  page.evaluate(async () => {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => {
        const parsed = new URL(url);
        return parsed.origin === location.origin && parsed.pathname.startsWith("/assets/");
      });
    const missing: string[] = [];
    // ignoreVary: the preview server answers module loads with `Vary: Origin`.
    for (const url of urls) if (!(await caches.match(url, { ignoreVary: true }))) missing.push(url);
    return missing;
  });

/** Every URL in every Cache Storage cache of this origin. */
const cachedUrls = (page: Page) =>
  page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });

test("after one online visit the app reloads offline and still renders the sample deck", async ({
  page,
  context,
}) => {
  await ready(page);
  await controlled(page);
  // The visit's own chunks (Mermaid's diagram types included) loaded before
  // the worker took over; they must reach the cache all the same.
  await expect.poll(() => uncachedAssets(page), { timeout: 15_000 }).toEqual([]);

  await context.setOffline(true);
  const response = await page.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  const status = page.locator(".docwalk-statusbar");
  await expect(status).toContainText(/\d+ slides/, { timeout: 30_000 });
  // Seven Mermaid diagrams in the sample: each needs its diagram-type chunk from the cache.
  await expect(status).toContainText("0 diagram errors");
  await expect(page.locator(".docwalk-outline-item").first()).toBeVisible();
  await expect(page.locator(".reveal .slides section").first()).toBeAttached();
  // The sample's TypeScript block: the highlighter is precached, and its
  // grammar was cached when the online visit used it (decision 76).
  await expect(
    page.locator(".reveal .slides code.language-ts .dw-code-keyword").first(),
  ).toHaveText("export");
});

test("the manifest parses without errors and Chromium finds the app installable", async ({
  page,
  browserName,
}) => {
  // Both checks are Chromium DevTools Protocol calls; Firefox and WebKit have
  // no equivalent. tooling/pwa.test.ts checks the manifest fields everywhere.
  test.skip(browserName !== "chromium", "CDP installability checks exist only in Chromium");
  await ready(page);
  await controlled(page);
  const cdp = await page.context().newCDPSession(page);
  const manifest = await cdp.send("Page.getAppManifest");
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toMatch(/\/manifest\.webmanifest$/);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  // Playwright's contexts are incognito, where Chromium never offers Install;
  // every other criterion (manifest, icons, worker) must pass.
  expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);

  // Every icon the manifest names is served, as the type it claims.
  const parsed = JSON.parse(manifest.data ?? "{}") as { icons: { src: string; type: string }[] };
  for (const icon of parsed.icons) {
    const res = await page.request.get(new URL(icon.src, manifest.url).href);
    expect({ icon: icon.src, status: res.status(), type: res.headers()["content-type"] }).toEqual({
      icon: icon.src,
      status: 200,
      type: expect.stringContaining(icon.type),
    });
  }
});

test("/api requests always reach the network and never land in a cache", async ({
  page,
  context,
  browserName,
}) => {
  await ready(page);
  await controlled(page);

  if (browserName === "webkit") {
    // WebKit sends a controlled page's requests past Playwright's routing, so
    // the answers cannot be counted there; the preview server answers instead,
    // and the Cache Storage check below still runs.
    for (let i = 0; i < 2; i++) await page.evaluate(() => fetch("/api/health").then(() => {}));
  } else {
    // A cacheable answer, to tempt any cache that would keep it.
    let served = 0;
    await context.route("**/api/health", (route) => {
      served += 1;
      return route.fulfill({
        json: { ok: true, n: served, features: [] },
        headers: { "Cache-Control": "public, max-age=3600" },
      });
    });
    const read = () =>
      page.evaluate(async () => {
        const res = await fetch("/api/health");
        return ((await res.json()) as { n: number }).n;
      });
    const first = await read();
    const second = await read();
    expect(second).toBe(first + 1);
    await context.unroute("**/api/health");
  }
  expect(
    (await cachedUrls(page)).filter((url) => new URL(url).pathname.startsWith("/api/")),
  ).toEqual([]);

  // Offline, an /api call fails as it would without a worker: a replayed
  // token or room answer would be worse than an error. `no-store` keeps the
  // browser's HTTP cache out of it (Firefox answers the max-age reply from
  // there); the request still passes through the worker, which must not answer.
  await context.setOffline(true);
  const offline = await page.evaluate(() =>
    fetch("/api/health", { cache: "no-store" }).then(
      () => "answered",
      () => "failed",
    ),
  );
  expect(offline).toBe("failed");
  // Nor does a navigation under /api get the app shell (the OAuth endpoints live there).
  // Chromium fails it offline; Firefox lets localhost through offline and the
  // preview server answers 404 (its error page never fires "load"). The
  // worker's shell would be a 200.
  const navigation = await page.goto("/api/health", { waitUntil: "commit" }).catch(() => null);
  expect(navigation?.status() ?? "failed").not.toBe(200);
});

/**
 * A static host for the built app whose sw.js can change between requests,
 * the way a deploy changes it. The preview server cannot do that per test,
 * and Playwright's routing never sees the browser's own update check for a
 * worker script, so each update test gets its own small server over dist/.
 */
async function deployment(): Promise<{
  url: string;
  publish: () => void;
  close: () => Promise<void>;
}> {
  const dist = join(import.meta.dirname, "..", "dist");
  let version = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = normalize(join(dist, path === "/" ? "index.html" : path));
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    let body: Buffer | string = readFileSync(file);
    if (path === "/sw.js") body = `${body.toString("utf8")}\n// deploy ${version}\n`;
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    publish: () => {
      version += 1;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

/** Opens the app on `site`, waits for its worker, then deploys a new sw.js and lets the page notice. */
async function openThenUpdate(page: Page, site: Awaited<ReturnType<typeof deployment>>) {
  await ready(page, site.url);
  await controlled(page);
  await page.evaluate(() => {
    (window as unknown as { docwalkBeforeUpdate: boolean }).docwalkBeforeUpdate = true;
  });
  site.publish();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
}

const notReloaded = (page: Page) => page.evaluate(() => "docwalkBeforeUpdate" in window);

test("a new version waits for the user: the prompt reloads only when asked", async ({ page }) => {
  const site = await deployment();
  try {
    await openThenUpdate(page, site);
    const toast = page.locator(".docwalk-toast");
    await expect(toast).toContainText("Update ready");
    // A toast, not a dialog: focus stays where the presenter left it.
    await expect(page.locator(".docwalk-toast-region :focus")).toHaveCount(0);
    await expect(page.locator(".docwalk-toast-region")).toHaveAttribute("role", "region");
    const axe = await new AxeBuilder({ page })
      .include(".docwalk-toast-region")
      .withTags(WCAG_22_AA)
      .analyze();
    expect(
      axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" | ")}`),
    ).toEqual([]);
    // The new worker waits; nothing has reloaded under the presenter.
    expect(await notReloaded(page)).toBe(true);
    expect(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state,
      ),
    ).toBe("installed");

    // Keyboard only: the region sits last in the document, so Shift+Tab from
    // the top of the page reaches its buttons within a few presses.
    const reload = toast.getByRole("button", { name: "Reload" });
    await page.locator("body").focus();
    for (let i = 0; i < 5 && !(await reload.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press("Shift+Tab");
    await expect(reload).toBeFocused();
    await Promise.all([page.waitForEvent("load"), page.keyboard.press("Enter")]);

    await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, {
      timeout: 30_000,
    });
    expect(await notReloaded(page)).toBe(false);
    // The update is in charge now, so the reloaded page has nothing to offer.
    expect(
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting),
    ).toBeNull();
    await expect(toast).toHaveCount(0);
  } finally {
    await site.close();
  }
});

test("dismissing the prompt keeps the page as it is", async ({ page }) => {
  const site = await deployment();
  try {
    await openThenUpdate(page, site);
    const toast = page.locator(".docwalk-toast");
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Dismiss" }).click();
    await expect(toast).toHaveCount(0);
    expect(await notReloaded(page)).toBe(true);
  } finally {
    await site.close();
  }
});

// Also the review screenshots (DOCWALK_SHOTS_DIR).
for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`the prompt fits a ${width} px viewport in ${scheme} mode`, async ({ page }) => {
      const site = await deployment();
      try {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await openThenUpdate(page, site);
        const toast = page.locator(".docwalk-toast");
        await expect(toast).toBeVisible();
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/update-${width}-${scheme}.png` });
        const box = await toast.boundingBox();
        const bar = await page.locator(".docwalk-statusbar").boundingBox();
        if (!box || !bar) throw new Error("toast or status bar not laid out");
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        // It clears the status bar at every width, so the offline note and
        // the slide counts stay readable; on a phone the bar wraps to more
        // lines, and the prompt still sits above all of them.
        expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
        // Nor may it cover the deck's next-slide arrow: a presenter who
        // has not dismissed it yet must still be able to move on.
        const next = await page.locator(".reveal .controls .navigate-right").boundingBox();
        if (next) {
          const overlaps =
            box.x < next.x + next.width &&
            next.x < box.x + box.width &&
            box.y < next.y + next.height &&
            next.y < box.y + box.height;
          expect(overlaps, "toast covers the next-slide arrow").toBe(false);
        }
        // Icon, text, Reload and Dismiss share one row even on a phone.
        const buttons = await toast
          .getByRole("button")
          .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
        expect(Math.max(...buttons) - Math.min(...buttons)).toBeLessThanOrEqual(8);
      } finally {
        await site.close();
      }
    });
  }
}
