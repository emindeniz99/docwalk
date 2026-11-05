import { readFile } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * Canvas mode (decision 54) in the built app, under its meta CSP. Unit and
 * browser tests cover the conversion and the store; only here do Excalidraw,
 * its self-hosted fonts and the lazy chunk meet the real policy, and only
 * here can the network be watched for a request to a third party.
 */

/** Opens the focus view of the section's first diagram, then its sketch. */
async function openSketch(page: Page, section: string) {
  await page.locator(".docwalk-outline-item", { hasText: section }).first().click();
  const diagram = page.locator(".reveal .present .docwalk-diagram").first();
  await expect(diagram.locator("svg")).toBeVisible();
  await diagram.click();
  await page.getByRole("dialog", { name: "Diagram, full screen" }).waitFor();
  await page.getByRole("button", { name: "Open as sketch" }).click();
  const dialog = page.getByRole("dialog", { name: "Sketch" });
  await expect(dialog).toBeVisible();
  // Excalidraw's interactive canvas exists once it mounts; Export waits for the converted scene.
  await expect(dialog.locator("canvas.interactive")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("button", { name: "Export" })).toBeEnabled({ timeout: 30_000 });
  return dialog;
}

/** The scene's elements, read from what the dialog saved in IndexedDB. */
async function storedSketches(page: Page) {
  return page.evaluate(
    () =>
      new Promise<
        { key: string; elements: { type: string; text?: string; isDeleted?: boolean }[] }[]
      >((resolve, reject) => {
        const open = indexedDB.open("docwalk-canvas");
        open.addEventListener("error", () => reject(open.error));
        open.addEventListener("success", () => {
          const all = open.result.transaction("sketches").objectStore("sketches").getAll();
          all.addEventListener("success", () => resolve(all.result));
          all.addEventListener("error", () => reject(all.error));
        });
      }),
  );
}

test("a diagram opens as a sketch, with no request to another origin", async ({
  page,
  baseURL,
}) => {
  // Excalidraw fetches its fonts from esm.sh unless told otherwise; a pasted
  // document must never cause a request the viewer did not ask for (rule 8,
  // decision 51). The CSP would block it, so watch both the network and
  // the policy's violation reports.
  const origin = new URL(baseURL ?? "http://localhost:4174").origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      foreign.push(url);
    }
  });
  await page.addInitScript(() => {
    (window as Window & { cspViolations?: string[] }).cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as Window & { cspViolations?: string[] }).cspViolations?.push(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  const fonts: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/excalidraw-assets/fonts/")) {
      fonts.push(`${response.status()} ${response.url()}`);
    }
  });

  await ready(page);
  const dialog = await openSketch(page, "Current architecture");
  await expect(dialog).toContainText("Diagram 1 · flowchart");

  // Draw text in the hand-drawn font so it must load, then let it settle.
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => fonts.length).toBeGreaterThan(0);
  expect(fonts.every((f) => f.startsWith("200 "))).toBe(true);
  expect(foreign).toEqual([]);
  expect(
    await page.evaluate(() => (window as Window & { cspViolations?: string[] }).cspViolations),
  ).toEqual([]);
});

test("a sketch keeps its edits: closing and reopening shows the same scene", async ({ page }) => {
  // Reopen where you left: the sketch, not a fresh conversion, comes back.
  await ready(page);
  let dialog = await openSketch(page, "Current architecture");
  await expect.poll(async () => (await storedSketches(page)).length).toBe(1);
  const converted = (await storedSketches(page))[0];
  const labels = converted?.elements.filter((e) => e.type === "text").map((e) => e.text);
  // The fixture's first diagram, converted: its node labels are canvas text.
  expect(labels).toEqual(expect.arrayContaining(["Client apps", "API gateway", "Payments API"]));

  // Delete everything; the store must follow. Click an empty spot (Excalidraw's
  // menus sit over the canvas corners), so its keys go to the scene.
  const box = await dialog.locator("canvas.interactive").boundingBox();
  await page.mouse.click(
    (box?.x ?? 0) + (box?.width ?? 0) - 30,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
  );
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expect
    .poll(async () => (await storedSketches(page))[0]?.elements.filter((e) => !e.isDeleted).length)
    .toBe(0);
  await dialog.getByRole("button", { name: "Close sketch" }).click();
  await expect(dialog).toBeHidden();

  dialog = await openSketch(page, "Current architecture");
  // Reopened from the store: still empty, not converted again.
  await expect.poll(async () => (await storedSketches(page)).length).toBe(1);
  expect((await storedSketches(page))[0]?.elements.filter((e) => !e.isDeleted)).toEqual([]);
});

test("a sketch exports as .excalidraw, PNG and SVG", async ({ page }) => {
  // Exports leave the browser as files the viewer keeps; each must be the real format.
  await ready(page);
  const dialog = await openSketch(page, "Current architecture");

  const exportAs = async (item: string) => {
    await dialog.getByRole("button", { name: "Export" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: item }).click();
    return download;
  };

  const json = await exportAs("Excalidraw file (.excalidraw)");
  expect(json.suggestedFilename()).toBe("ledgerline-payment-ledger-redesign-diagram-1.excalidraw");
  const scene = JSON.parse(await readFile(await json.path(), "utf8")) as {
    type: string;
    elements: { type: string; text?: string; link?: string | null }[];
  };
  expect(scene.type).toBe("excalidraw");
  expect(scene.elements.map((e) => e.text)).toContain("Payments API");

  const png = await exportAs("PNG image");
  expect(png.suggestedFilename()).toMatch(/\.png$/);
  const bytes = await readFile(await png.path());
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const svg = await exportAs("SVG image");
  expect(svg.suggestedFilename()).toMatch(/\.svg$/);
  const text = await readFile(await svg.path(), "utf8");
  expect(text).toMatch(/^<svg/);
  expect(text).toContain("Payments API");
  // An exported SVG is opened elsewhere; nothing executable may ride along.
  expect(text).not.toMatch(/<script|\son\w+=/i);
});

test("Escape in the header closes the sketch and focus returns to the diagram", async ({
  page,
}) => {
  // Escape inside the canvas cancels an Excalidraw tool; in the header it closes the dialog.
  await ready(page);
  const dialog = await openSketch(page, "Current architecture");
  await dialog.getByRole("button", { name: "Export" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".reveal .present .docwalk-diagram").first()).toBeFocused();
});

test("while presenting, the sketch owns its keys and Escape leaves only the sketch", async ({
  page,
}) => {
  // P, A and E are Excalidraw tools and docwalk's pen shortcuts; presenting,
  // docwalk listens on the whole window, and Escape also leaves present mode.
  await ready(page);
  await page.locator(".docwalk-outline-item", { hasText: "Current architecture" }).first().click();
  await page.getByRole("button", { name: "Present" }).first().click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  const diagram = page.locator(".reveal .present .docwalk-diagram").first();
  await diagram.click();
  await page.getByRole("button", { name: "Open as sketch" }).click();
  const dialog = page.getByRole("dialog", { name: "Sketch" });
  await expect(dialog.getByRole("button", { name: "Export" })).toBeEnabled({ timeout: 30_000 });

  await page.keyboard.press("p");
  // Excalidraw took P (its free-draw tool).
  await expect(dialog.locator('input[data-testid="toolbar-freedraw"]')).toBeChecked();
  // O is Excalidraw's ellipse and docwalk's slide overview: the sketch keeps it too.
  await page.keyboard.press("o");
  await expect(dialog.locator('input[data-testid="toolbar-ellipse"]')).toBeChecked();
  await expect(page.getByRole("dialog", { name: "Slide overview" })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Export" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  // docwalk's pen (hidden behind the modal until now) stayed off.
  await expect(page.getByRole("radio", { name: "Pen" })).not.toBeChecked();
});

test("the sketch dialog passes axe, less two known Excalidraw controls", async ({ page }) => {
  // The dialog (header, export menu, close) and Excalidraw's toolbar must pass
  // WCAG 2.2 AA. Two controls inside Excalidraw 0.18.1 fail and are not ours
  // to change; they are excluded by name, so anything new still fails here:
  // - `.main-menu-trigger`: the hamburger button has no accessible name (button-name);
  // - `.reset-zoom-button`: its name does not contain its visible "60%" (label-content-name-mismatch).
  await ready(page);
  await openSketch(page, "Current architecture");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude(".excalidraw .main-menu-trigger")
    .exclude(".excalidraw .reset-zoom-button")
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
});
