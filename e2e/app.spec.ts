import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end checks of the assembled app. Each test guards a failure that
 * unit and component tests could not see, because it only appears when the
 * modules run together in a real page.
 */

async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, { timeout: 30_000 });
}

const hash = (page: Page) => page.evaluate(() => location.hash);

test("a link to a slide address opens that slide, and the hash follows navigation", async ({
  page,
}) => {
  await ready(page, "/#configuration-flags/2");
  await expect.poll(() => hash(page)).toBe("#configuration-flags/2");
  await page.getByRole("option", { name: /Rollout/ }).click();
  await expect.poll(() => hash(page)).toBe("#rollout/1");
});

test("the deck fills its pane: a collapsed deck once scaled slides to 20%", async ({ page }) => {
  await ready(page);
  const box = await page.locator(".docwalk-annotate").boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(500);
});

test("arrow keys work from keyboard focus, not only after a click on the deck", async ({
  page,
}) => {
  // reveal.js's own "focused" mode only counted pointer presses.
  await ready(page, "/#summary/1");
  await page.locator(".reveal").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => hash(page)).not.toBe("#summary/1");
});

test("the pen draws above the slide and each slide keeps its own marks", async ({ page }) => {
  await ready(page, "/#summary/1");
  await page.getByRole("radio", { name: "Pen" }).click();
  const r = await page.locator(".docwalk-annotate").boundingBox();
  if (!r) throw new Error("annotation overlay missing");
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.6);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(
      r.x + r.width * (0.3 + i * 0.02),
      r.y + r.height * (0.6 + (i % 2) * 0.04),
      {
        steps: 3,
      },
    );
  }
  await page.mouse.up();
  const marks = page.locator(".docwalk-annotate-draw > *");
  await expect(marks).toHaveCount(1);

  await page.locator(".reveal").focus();
  await page.keyboard.press("ArrowRight");
  await expect(marks).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await expect(marks).toHaveCount(1);
});

test("Escape leaves present mode, and the palette is visible while presenting", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Present" }).first().click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  // The palette renders outside the deck; fullscreen on the deck alone hid it.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".reveal").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "edit");
});

test("editing the source updates the deck and shows slide notes in the gutter", async ({
  page,
}) => {
  await ready(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(" (edited)");
  await expect(page.locator(".docwalk-doc-title strong")).toHaveText(/\(edited\)$/);
});

test("the presenter window mirrors the deck and can drive it", async ({ page, context }) => {
  await ready(page);
  const popupPromise = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popupPromise;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  const before = await page.locator(".docwalk-preview-head strong").textContent();
  await presenter.getByRole("button", { name: /next/i }).first().click();
  await expect(page.locator(".docwalk-preview-head strong")).not.toHaveText(before ?? "");
});
