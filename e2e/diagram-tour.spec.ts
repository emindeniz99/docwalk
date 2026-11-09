import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * The diagram tour in the diagram focus view (decision 109) in the built app.
 * The component tests (`diagramTourView.browser.test.ts`) cover the keys and
 * the state; these cover what only the whole page shows: a phone-sized window
 * where a tap picks a node, the toolbar's 44 px targets, axe on the real
 * backgrounds with the tour running, and the layered Escape of a talk.
 */

// The diagram is on the last slide: presenting starts at the slide the editor's cursor is on, the end.
const DOC = [
  "## Intro",
  "",
  "A slide before the diagram, so an arrow that leaked to the talk would show.",
  "",
  "## Flow",
  "",
  "```mermaid",
  "flowchart LR",
  "  a[Client] --> b[Gateway]",
  "  b --> c[Service]",
  "  c --> d[Database]",
  "```",
  "",
].join("\n");

const present = (page: Page) => page.locator(".reveal .slides > section.present");
const view = (page: Page) => page.locator(".docwalk-focus");
const status = (page: Page) => view(page).locator(".docwalk-tour-status");
const ring = (page: Page) => view(page).locator(".docwalk-tour-ring");

async function openView(page: Page) {
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.locator(".docwalk-statusbar")).toContainText(/(?<!\d)2 slides/);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await present(page).locator(".docwalk-diagram").click();
  await expect(view(page)).toBeVisible();
  await expect(view(page).locator("svg g.node")).toHaveCount(4);
}

/** Where the centre of the view's node with this label is on screen. */
async function centreOf(page: Page, label: string) {
  const box = await view(page)
    .locator("svg g.node", { hasText: label })
    .evaluate((node) => {
      const { left, top, width, height } = node.getBoundingClientRect();
      return { x: left + width / 2, y: top + height / 2 };
    });
  return box;
}

test("T starts the tour, the keys step it and Escape ends it before it closes the view", async ({
  page,
}) => {
  await openView(page);
  const slide = await present(page).getAttribute("data-docwalk-id");

  await page.keyboard.press("t");
  await expect(status(page)).toContainText("Client. Node 1 of 4.");
  await expect(ring(page)).toHaveCount(1);
  await expect(view(page).getByRole("button", { name: "Next node" })).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(status(page)).toContainText("Gateway. Node 2 of 4.");
  await expect(status(page)).toContainText("Linked to: Client, Service.");
  await page.keyboard.press("PageDown");
  await expect(status(page)).toContainText("Service. Node 3 of 4.");
  await page.keyboard.press("ArrowLeft");
  await expect(status(page)).toContainText("Gateway. Node 2 of 4.");
  // The arrows steered the tour, not the talk behind the view.
  expect(await present(page).getAttribute("data-docwalk-id")).toBe(slide);

  // The first Escape ends the tour and keeps the view; the second closes the view.
  await page.keyboard.press("Escape");
  await expect(ring(page)).toHaveCount(0);
  await expect(view(page).locator(".docwalk-tour-layer")).toHaveCount(0);
  await expect(view(page)).toBeVisible();
  await expect(view(page).getByRole("button", { name: "Tour" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
});

test.describe("on a phone", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("a tap on a node moves the tour, Back and Next stay on screen at 44 px and axe finds nothing", async ({
    page,
  }) => {
    await openView(page);
    await view(page).getByRole("button", { name: "Tour" }).tap();
    await expect(status(page)).toContainText("Client. Node 1 of 4.");

    // The status names the node a tap picked.
    const at = await centreOf(page, "Database");
    await page.touchscreen.tap(at.x, at.y);
    await expect(status(page)).toContainText("Database. Node 4 of 4.");
    await expect(ring(page)).toHaveCount(1);
    await expect(view(page).locator(".docwalk-tour-count")).toHaveText("4 / 4");

    const sizes = await page.evaluate(() => {
      const toolbar = document.querySelector(".docwalk-focus-toolbar")!;
      const named = (name: string) => {
        const b = toolbar.querySelector(`[aria-label="${name}"]`)!;
        const { left, right, bottom, width, height } = b.getBoundingClientRect();
        return { left, right, bottom, width, height };
      };
      return {
        page: document.documentElement.scrollWidth,
        window: innerWidth,
        height: innerHeight,
        back: named("Previous step"),
        next: named("Next node"),
      };
    });
    expect(sizes.page).toBeLessThanOrEqual(sizes.window);
    for (const b of [sizes.back, sizes.next]) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(sizes.window);
      expect(b.bottom).toBeLessThanOrEqual(sizes.height);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }

    // Back removes the tapped step and returns to the first node.
    await view(page).getByRole("button", { name: "Previous step" }).tap();
    await expect(status(page)).toContainText("Client. Node 1 of 4.");

    // Jump running transitions to their end so axe reads settled colours (see focus-view.spec.ts).
    const left = await page.evaluate(() => {
      for (let pass = 0; pass <= 10; pass++) {
        const running = document
          .getAnimations()
          .filter((a): a is CSSTransition => a instanceof CSSTransition);
        if (running.length === 0 || pass === 10) return running.map((a) => a.transitionProperty);
        for (const a of running) a.finish();
      }
      return [];
    });
    expect(left, "transitions still running after ten passes").toEqual([]);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    expect(serious).toEqual([]);
  });
});
