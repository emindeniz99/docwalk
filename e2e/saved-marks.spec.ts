import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * Saved marks (decision 105) in the built app. The layer, the store and the
 * exporters have their own tests; only here do they meet the document
 * identity comments compute, a real page reload, the Export menu, the
 * palette and the More menu.
 */

/** The marks a viewer can see: every visited slide keeps its own surface. */
const marks = (page: Page) => page.locator(".docwalk-annotate-draw > *").filter({ visible: true });

async function drawLine(page: Page) {
  await page.getByRole("radio", { name: "Pen" }).click();
  const r = await page.locator(".docwalk-annotate").boundingBox();
  if (!r) throw new Error("annotation overlay missing");
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(r.x + r.width * (0.3 + i * 0.03), r.y + r.height * 0.6, { steps: 3 });
  }
  await page.mouse.up();
  // Leave the pen, so the next clicks reach the slide and the header.
  await page.getByRole("radio", { name: "Pen" }).click();
}

async function exportHtml(page: Page): Promise<string> {
  const trigger = page.getByRole("button", { name: "Export" });
  await expect(trigger).toBeEnabled();
  const download = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download HTML" }).click();
  return readFile(await (await download).path(), "utf8");
}

/**
 * The slide count the status bar shows once a reload has rendered. `ready()`
 * gives a first open 30 s; a reload renders the same deck and needs the same,
 * since under load the 5 s default left the bar at "Rendering…" and failed
 * these checks twice.
 */
const rendered = (page: Page) =>
  expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides?/, { timeout: 30_000 });

const overlays = (html: string) => (html.match(/class="docwalk-export-marks"/g) ?? []).length;

test("a mark survives a reload, goes into the HTML export, and is gone for good once deleted", async ({
  page,
}) => {
  await ready(page, "/#summary/1");
  await drawLine(page);
  await expect(marks(page)).toHaveCount(1);

  // A reload drops the layer and every drauu surface; the mark comes back from IndexedDB.
  await page.reload();
  await rendered(page);
  await expect(marks(page)).toHaveCount(1);
  await page.locator(".reveal").focus();
  await page.keyboard.press("ArrowRight");
  await expect(marks(page)).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await expect(marks(page)).toHaveCount(1);

  // In the export by default, on the slide it was drawn on only.
  const html = await exportHtml(page);
  expect(overlays(html)).toBe(1);
  expect(html).toMatch(/<path[^>]*data-tool="pen"[^>]*data-color="primary"/);

  // "Include marks" leaves them out without deleting anything; the menu stays open for the export.
  await page.getByRole("button", { name: "Export" }).click();
  const include = page.getByRole("menuitemcheckbox", { name: "Include marks" });
  await expect(include).toHaveAttribute("aria-checked", "true");
  await include.click();
  await expect(include).toHaveAttribute("aria-checked", "false");
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download HTML" }).click();
  expect(overlays(await readFile(await (await download).path(), "utf8"))).toBe(0);
  await expect(marks(page)).toHaveCount(1);

  // Reachable from the More menu and the palette; the palette runs it here.
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete saved marks…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("searchbox").fill("saved marks");
  await palette.getByRole("menuitem", { name: "Delete saved marks…" }).click();

  const confirm = page.getByRole("alertdialog", { name: "Delete the saved marks?" });
  await expect(confirm).toContainText("1 slide");
  await confirm.getByRole("button", { name: "Delete marks" }).click();
  await expect(confirm).toBeHidden();
  await expect(marks(page)).toHaveCount(0);
  await expect(page.locator(".docwalk-notice")).toContainText("Saved marks deleted.");

  await page.reload();
  await rendered(page);
  await expect(page.locator(".docwalk-annotate")).toBeAttached();
  await expect(marks(page)).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete saved marks…" })).toHaveCount(0);
});

test("cancelling the confirmation keeps every saved mark", async ({ page }) => {
  await ready(page, "/#summary/1");
  await drawLine(page);
  await expect(marks(page)).toHaveCount(1);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete saved marks…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete the saved marks?" });
  // Cancel has the focus, so Enter on a dialog opened by mistake deletes nothing.
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  await page.reload();
  await rendered(page);
  await expect(marks(page)).toHaveCount(1);
});
