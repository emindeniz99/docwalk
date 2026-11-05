import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource, SHORT_DOC } from "./helpers";

/**
 * Exports (decision 9) from the real deck. The exporters are unit-tested on
 * hand-made slides; only here do they receive the pages the app actually
 * rendered and paginated, through the menu in the header.
 */

async function exportAs(page: Page, item: string) {
  const trigger = page.getByRole("button", { name: "Export" });
  // The menu loads lazily; until then a disabled stand-in holds its place.
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("HTML export downloads one file with the slides' titles and no script", async ({ page }) => {
  // The file is opened offline by people who never saw docwalk: it must be
  // the document's own slides, and inert (no script survives the sanitizer).
  await ready(page);
  const download = page.waitForEvent("download");
  await exportAs(page, "Download HTML");
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.html$/);
  const html = await readFile(await file.path(), "utf8");
  expect(html).not.toMatch(/<script/i);
  for (const title of ["Ledgerline: payment ledger redesign", "Summary", "Rollout", "Security"]) {
    expect(html).toContain(title);
  }
  const slides = await page.locator(".docwalk-outline-item").count();
  expect(slides).toBeGreaterThan(10);
  expect((html.match(/class="docwalk-export-page"/g) ?? []).length).toBeGreaterThanOrEqual(slides);
});

test("PNG export downloads real PNG images of the slides", async ({ page }) => {
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);
  const download = page.waitForEvent("download");
  await exportAs(page, "Download PNG images");
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  const bytes = await readFile(await file.path());
  // The PNG signature: a browser that failed to encode would hand over an empty or text blob.
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("print fills a hidden print frame with every slide and opens the print dialog once", async ({
  page,
}) => {
  // A real print dialog would block the test; the stub counts calls in every frame.
  await page.addInitScript(() => {
    window.print = () => {
      const top = window.top as Window & { docwalkPrintCalls?: number };
      top.docwalkPrintCalls = (top.docwalkPrintCalls ?? 0) + 1;
    };
  });
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);
  await exportAs(page, "Print or save as PDF");

  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { docwalkPrintCalls?: number }).docwalkPrintCalls),
    )
    .toBe(1);
  const frame = page.locator("iframe[data-docwalk-print]");
  await expect(frame).toHaveCount(1);
  // Hidden from assistive technology and focus while it waits for the dialog.
  await expect(frame).toHaveAttribute("aria-hidden", "true");
  const pages = page.frameLocator("iframe[data-docwalk-print]").locator(".docwalk-export-page");
  await expect(pages).toHaveCount(3);
  await expect(pages.first()).toContainText("Round trip");
});
