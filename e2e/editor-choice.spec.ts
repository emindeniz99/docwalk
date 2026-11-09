import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { SHORT_DOC, ready, replaceSource } from "./helpers";

/**
 * The editor choice (decision 53): Monaco behind the same props contract as
 * CodeMirror, picked in the More menu, remembered per browser, never offered
 * on touch screens, and never downloaded by anyone who did not pick it.
 */

const MONACO_ASSET = /\/assets\/(MonacoEditor|editor\.worker|codicon)-/;
const address = (page: Page) => page.locator(".docwalk-preview-head > span");
const monacoLines = (page: Page) => page.locator(".monaco-editor .view-lines");
const top = async (line: Locator) => (await line.boundingBox())?.y ?? Number.NaN;
// Monaco follows the page's user agent; Playwright's ControlOrMeta follows the host OS.
const findKey = (page: Page) =>
  page.evaluate(() => (navigator.platform.startsWith("Mac") ? "Meta+f" : "Control+f"));

async function pickEditor(page: Page, name: "CodeMirror" | "Monaco") {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

test("switching to Monaco keeps the text, and its cursor still moves the preview", async ({
  page,
}) => {
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await pickEditor(page, "Monaco");
  // The document lives in the shell, not in the editor: nothing typed is lost on a switch.
  await expect(monacoLines(page)).toContainText("Second point");
  await expect(page.locator(".cm-content")).toHaveCount(0);

  // The preview follows the cursor (decision 4's onCursorLine), so the
  // presenter can rehearse from the source in either editor.
  await page.locator(".monaco-editor .view-line", { hasText: "Second point" }).click();
  await expect(address(page)).toHaveText(/^second-point/);
  await page.locator(".monaco-editor .view-line", { hasText: "First point" }).click();
  await expect(address(page)).toHaveText(/^first-point/);

  // An edit in Monaco reaches the deck, and survives the switch back.
  await page.keyboard.press("End");
  await page.keyboard.insertText(" edited in Monaco");
  await expect(page.locator(".docwalk-outline-item").nth(1)).toContainText(
    "First point edited in Monaco",
  );
  await pickEditor(page, "CodeMirror");
  await expect(page.locator(".cm-content")).toContainText("First point edited in Monaco");
});

test("the choice is remembered on reload and shown as the checked radio item", async ({ page }) => {
  await ready(page);
  await pickEditor(page, "Monaco");
  await expect(monacoLines(page)).toBeVisible();
  await page.reload();
  await expect(monacoLines(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Monaco" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("menuitemradio", { name: "CodeMirror" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("only viewers who pick Monaco download it, and it loads from this origin under the CSP", async ({
  page,
}) => {
  // Monaco is about 830 kB gzip: the default path must not pay for it, and
  // when it does load, its worker and font come from the build, never a CDN.
  const assets: string[] = [];
  const violations: string[] = [];
  page.on("request", (r) => {
    if (MONACO_ASSET.test(r.url())) assets.push(r.url());
  });
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await ready(page);
  await expect(page.locator(".cm-content")).toBeVisible();
  expect(assets).toEqual([]);

  await pickEditor(page, "Monaco");
  await expect(monacoLines(page)).toBeVisible();
  await page.locator(".monaco-editor .view-line").first().click();
  await page.keyboard.insertText("x");
  await expect.poll(() => assets.some((u) => u.includes("/MonacoEditor-"))).toBe(true);
  // Markdown editing rarely needs Monaco's worker, so start it the way Monaco
  // would: it must come from this build and pass `worker-src 'self'`.
  const started = page.waitForEvent("worker");
  await page.evaluate(() => {
    type Env = { getWorker?: (id: string, label: string) => unknown };
    (globalThis as { MonacoEnvironment?: Env }).MonacoEnvironment?.getWorker?.(
      "test",
      "editorWorkerService",
    );
  });
  expect(MONACO_ASSET.test((await started).url())).toBe(true);
  const origin = new URL(page.url()).origin;
  assets.push((await started).url());
  // Firefox reports a worker's URL as written (`/assets/…`); resolve it first.
  expect(assets.filter((u) => new URL(u, origin).origin !== origin)).toEqual([]);
  expect(violations).toEqual([]);
});

test("touch screens keep CodeMirror and are not offered Monaco", async ({ browser }) => {
  // Monaco has no mobile support (decision 4); a choice stored on a desktop
  // must not leave a phone with an editor it cannot type in.
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript(() => localStorage.setItem("docwalk.editor", "monaco"));
  const page = await context.newPage();
  await ready(page);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  // A finger taps; Firefox's mobile emulation does not open the menu on a mouse click.
  await page.getByRole("button", { name: "More actions" }).tap();
  await expect(page.getByRole("menu", { name: "More actions" })).toBeVisible();
  // The language radios (decision 56) stay; the editor's are gone.
  await expect(page.getByRole("menuitemradio", { name: /CodeMirror|Monaco/ })).toHaveCount(0);
  // The palette follows the menu: no command to switch to an editor the device cannot use.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("searchbox").fill("Editor: use");
  await expect(palette.getByRole("menuitem", { name: /Editor: use/ })).toHaveCount(0);
  await context.close();
});

test("the edit view with Monaco and the open editor menu pass axe", async ({ page }) => {
  await ready(page);
  await pickEditor(page, "Monaco");
  await expect(monacoLines(page)).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Monaco" })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
});

test("the cursor line goes with the viewer to the other editor and back", async ({ page }) => {
  // Without a starting cursor the other editor opened on line 1, and a viewer
  // working in a long document had to find their place again after every switch.
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await page.locator(".cm-line", { hasText: "Second point" }).click();
  await pickEditor(page, "Monaco");
  await expect(monacoLines(page)).toContainText("Second point");
  const marked = page.locator(".monaco-editor .view-overlays .current-line");
  await expect
    .poll(async () => {
      const second = page.locator(".monaco-editor .view-line", { hasText: "Second point" });
      return Math.abs((await top(marked)) - (await top(second)));
    })
    .toBeLessThan(2);

  await page.locator(".monaco-editor .view-line", { hasText: "First point" }).click();
  await pickEditor(page, "CodeMirror");
  await expect(page.locator(".cm-activeLine")).toContainText("First point");
});

test("a pick made in one tab switches the other open tab", async ({ context, page }) => {
  // The choice lives in localStorage, which every tab shares; two windows of
  // the same document showing different editors would look like a bug.
  await ready(page);
  const other = await context.newPage();
  await ready(other);
  await pickEditor(other, "Monaco");
  await expect(monacoLines(other)).toBeVisible();
  await expect(monacoLines(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".cm-content")).toHaveCount(0);
});

test("the command palette offers the other editor and switches to it", async ({ page }) => {
  await ready(page);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  // React Aria wraps the "No match" text in a menuitem of its own; it is not a command.
  const results = palette
    .getByRole("menuitem")
    .filter({ hasNot: page.locator(".docwalk-palette-empty") });
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("searchbox").fill("Editor: use");
  await expect(results).toHaveCount(1);
  await palette.getByRole("menuitem", { name: "Editor: use Monaco" }).click();
  await expect(monacoLines(page)).toBeVisible();

  // Now it offers the way back, and the More menu shows the same state.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("searchbox").fill("Editor: use");
  await expect(results).toHaveCount(1);
  await palette.getByRole("menuitem", { name: "Editor: use CodeMirror" }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitemradio", { name: "CodeMirror" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("Monaco's own panels speak English to an English viewer", async ({ page }) => {
  await ready(page);
  await pickEditor(page, "Monaco");
  await page.locator(".monaco-editor .view-line").first().click();
  await page.keyboard.press(await findKey(page));
  await expect(
    page.locator(".monaco-editor .find-widget").getByRole("textbox", { name: "Find" }),
  ).toBeVisible();
});

test.describe("a browser that prefers Turkish", () => {
  test.use({ locale: "tr-TR" });

  test("Monaco's find panel and context text are Turkish, as the rest of the app is", async ({
    page,
  }) => {
    // Monaco ships its own interface text, in English unless a language table
    // is loaded before its modules run; the app around it is already Turkish.
    await page.goto("/");
    await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slayt/, {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Diğer işlemler" }).click();
    await page.getByRole("menuitemradio", { name: "Monaco" }).click();
    await expect(monacoLines(page)).toBeVisible({ timeout: 30_000 });
    await page.locator(".monaco-editor .view-line").first().click();
    await page.keyboard.press(await findKey(page));
    await expect(
      page.locator(".monaco-editor .find-widget").getByRole("textbox", { name: "Bul" }),
    ).toBeVisible();
  });
});
