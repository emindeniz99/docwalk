import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { SHORT_DOC, ready, replaceSource } from "./helpers";

/**
 * The editor choice (decision 53): Monaco behind the same props contract as
 * CodeMirror, picked in the More menu, remembered per browser, never offered
 * on touch screens, and never downloaded by anyone who did not pick it.
 */

const MONACO_ASSET = /\/assets\/(MonacoEditor|editor\.worker|codicon)-/;
const address = (page: Page) => page.locator(".docwalk-preview-head > span");
const monacoLines = (page: Page) => page.locator(".monaco-editor .view-lines");

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
  expect(assets.filter((u) => !u.startsWith(origin))).toEqual([]);
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
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu", { name: "More actions" })).toBeVisible();
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
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
