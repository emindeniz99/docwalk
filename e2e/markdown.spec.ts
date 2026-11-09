import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Markdown fidelity in the built app: GitHub alerts, footnotes on the slide
 * that cites them, raw HTML GitHub allows, links to sub-headings and
 * emoji-only headings. Each one passed its unit and component tests; these
 * check the assembled deck, where reveal.js, pagination and the URL sync
 * all touch the same markup.
 */

const DOC = [
  "# Fidelity check",
  "",
  "## Alerts",
  "",
  "> [!NOTE]",
  "> Useful information.",
  "",
  "> [!WARNING]",
  "> Rotate the keys first.",
  "",
  "## Sources",
  "",
  "The ledger settles daily.[^daily] Refunds take longer.[^refunds]",
  "",
  "Press <kbd>Ctrl</kbd> + <kbd>K</kbd>, see [the retry budget](#retry-budget).",
  "",
  "Escalate along [the escalation path](#escalation-path).",
  "",
  "## 🚀",
  "",
  "Launch plan.",
  "",
  "## Failure handling",
  "",
  ...Array.from({ length: 24 }, (_, i) => `Failure note ${i + 1}.\n`),
  "#### Retry budget",
  "",
  "Three retries, then give up.",
  "",
  "<details>",
  "<summary>Why three</summary>",
  "",
  "Measured on the *staging* ledger.",
  "",
  "</details>",
  "",
  "## Settlement",
  "",
  "Settlement runs nightly.[^nightly]",
  "",
  ...Array.from({ length: 24 }, (_, i) => `Settlement detail ${i + 1}.\n`),
  "Late files wait a day.[^late]",
  "",
  "> [!TIP]",
  "> #### Escalation path",
  ">",
  "> Page the on-call lead.",
  "",
  "[^daily]: At 02:00 UTC.",
  "[^refunds]: Up to five business days.",
  "[^nightly]: After the ledger closes.",
  "[^late]: Up to one business day.",
  "",
].join("\n");

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousViolations(page: Page, include?: string) {
  // Buttons fade their background over 120 ms after a theme switch or a
  // hover; axe sampling mid-fade measured a colour pair no one ever sees
  // (WebKit, one run in three). Judge the settled colours: jump every
  // running transition to its end (Firefox can leave them running for
  // seconds when it paints no frames, so waiting is not enough).
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish();
  });
  const builder = new AxeBuilder({ page }).withTags(WCAG_22_AA);
  const results = await (include ? builder.include(include) : builder).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
}

const present = (page: Page) => page.locator(".reveal .slides > section.present");

async function openDoc(page: Page) {
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/);
  await expect(
    page.locator(".reveal .slides > section[data-docwalk-id='heading-1f680']"),
  ).toHaveCount(1);
}

/** Goes to a slide the way a shared link does: through the URL hash. */
async function followHash(page: Page, hash: string) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

test("alerts render like GitHub's on the slide", async ({ page }) => {
  await openDoc(page);
  await followHash(page, "#alerts");
  await expect(present(page).locator(".markdown-alert-note .markdown-alert-title")).toHaveText(
    "Note",
  );
  await expect(present(page).locator(".markdown-alert-warning")).toContainText(
    "Rotate the keys first.",
  );
  await expect(present(page)).not.toContainText("[!NOTE]");
});

test("a footnote shows on its slide, and following it keeps the slide", async ({ page }) => {
  await openDoc(page);
  await followHash(page, "#sources");
  await expect(present(page).locator(".footnotes")).toContainText("At 02:00 UTC.");
  // A real pointer click: reveal.js once read the footnote <section> as a
  // vertical slide, whose background then swallowed every click on the slide.
  await present(page).locator("a[data-footnote-ref]").first().click();
  await expect(page.locator(":focus")).toHaveAttribute("id", "user-content-sources-fn-daily");
  await expect(page).toHaveURL(/#sources\/1$/);
  await present(page).locator(".data-footnote-backref").first().click();
  await expect(page.locator(":focus")).toHaveAttribute("data-footnote-ref", "");
});

test("a link to a sub-heading opens the slide that holds it", async ({ page }) => {
  await openDoc(page);
  // From a shared URL …
  await followHash(page, "#retry-budget");
  await expect(present(page).locator("#user-content-retry-budget")).toBeVisible();
  await expect(page).toHaveURL(/#failure-handling\/\d+$/);
  // … and from a link inside another slide.
  await followHash(page, "#sources");
  await expect(present(page)).toHaveAttribute("data-docwalk-id", "sources");
  await present(page).getByRole("link", { name: "the retry budget" }).click();
  await expect(present(page).locator("#user-content-retry-budget")).toBeVisible();
});

test("a link to a heading inside an alert opens its slide and its place in document view", async ({
  page,
}) => {
  // Decision 107: only headings at the top of the tree had anchors.
  await openDoc(page);
  await followHash(page, "#escalation-path");
  await expect(present(page).locator("#user-content-escalation-path")).toBeVisible();
  await expect(page).toHaveURL(/#settlement\/\d+$/);
  await followHash(page, "#sources");
  await expect(present(page)).toHaveAttribute("data-docwalk-id", "sources");
  await present(page).getByRole("link", { name: "the escalation path" }).click();
  await expect(present(page).locator("#user-content-escalation-path")).toBeVisible();
  await page.getByRole("radio", { name: "Document" }).click();
  const doc = page.locator(".docwalk-document");
  await doc.getByRole("link", { name: "the escalation path" }).click();
  await expect(page.locator(":focus")).toHaveAttribute("id", "user-content-escalation-path");
  await expect(page.locator(":focus")).toBeInViewport();
});

test("an emoji-only heading gets a slide address that a link can hold", async ({ page }) => {
  await openDoc(page);
  await followHash(page, "#heading-1f680");
  await expect(present(page)).toContainText("Launch plan.");
  await expect(page).toHaveURL(/#heading-1f680\/1$/);
});

test("raw HTML: <details> opens on the slide and <kbd> renders as a key", async ({ page }) => {
  await openDoc(page);
  await followHash(page, "#retry-budget");
  const details = present(page).locator("details");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details.locator("em")).toHaveText("staging");
  await followHash(page, "#sources");
  await expect(present(page).locator("kbd")).toHaveText(["Ctrl", "K"]);
});

test("document view: footnotes at the end, links resolved as on GitHub", async ({ page }) => {
  await openDoc(page);
  await page.getByRole("radio", { name: "Document" }).click();
  const doc = page.locator(".docwalk-document");
  await expect(doc.locator(".footnotes li")).toHaveCount(4);
  await doc.locator("a[data-footnote-ref]").first().click();
  await expect(page.locator(":focus")).toHaveAttribute("id", "user-content-fn-daily");
  await expect(page.locator(":focus")).toBeInViewport();
  await doc.getByRole("link", { name: "the retry budget" }).click();
  await expect(page.locator(":focus")).toHaveAttribute("id", "user-content-retry-budget");
});

test("axe: the new content passes in document view, light and dark", async ({ page }) => {
  await openDoc(page);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(page.locator(".docwalk-document .markdown-alert")).toHaveCount(3);
  await expectNoSeriousViolations(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousViolations(page);
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe: alerts, footnotes and links pass on a slide, ${scheme} theme`, async ({ page }) => {
    // Roles, names and structure of the new markup on a real slide. axe
    // cannot judge colour on reveal's scaled slide (it passed with 2.4:1
    // links), so colours are asserted in src/render/markdown.browser.test.ts.
    await page.emulateMedia({ colorScheme: scheme });
    await openDoc(page);
    for (const hash of ["#alerts", "#sources"]) {
      await followHash(page, hash);
      await expect(present(page)).toHaveAttribute("data-docwalk-id", hash.slice(1));
      await expectNoSeriousViolations(page, ".reveal .slides > section.present");
    }
  });
}

// ---- Screenshots for review (not assertions) -------------------------------

const SHOTS = process.env.DOCWALK_SHOTS_DIR;

for (const width of [390, 1440]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshots at ${width} px, ${scheme}`, async ({ page }) => {
      test.skip(!SHOTS, "set DOCWALK_SHOTS_DIR to save review screenshots");
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await openDoc(page);
      await page.screenshot({ path: `${SHOTS}/edit-${width}-${scheme}.png` });
      // At phone width the edit view shows the source, not the stage.
      await page.getByRole("button", { name: "Present" }).click();
      await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
      for (const hash of ["#alerts", "#sources", "#retry-budget"]) {
        await followHash(page, hash);
        await expect(present(page)).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/slide-${hash.slice(1)}-${width}-${scheme}.png` });
      }
      await page.keyboard.press("Escape");
      await expect(page.locator(".docwalk-app")).not.toHaveAttribute("data-view", "present");
      await page.getByRole("radio", { name: "Document" }).click();
      const doc = page.locator(".docwalk-document");
      await doc.locator(".markdown-alert").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/document-alerts-${width}-${scheme}.png` });
      await doc.locator(".footnotes").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/document-footnotes-${width}-${scheme}.png` });
    });
  }
}
