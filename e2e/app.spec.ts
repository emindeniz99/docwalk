import { expect, test, type Page } from "@playwright/test";
import { replaceSource } from "./helpers";

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
  // Every visited slide keeps its own surface; count the marks a viewer can see.
  const marks = page.locator(".docwalk-annotate-draw > *").filter({ visible: true });
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
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  // The first Escape is for the palette: it closes and presenting goes on.
  // Firefox and WebKit spend that key on leaving fullscreen, and the app
  // closes the palette on the fullscreenchange that ends the exit, frames
  // later. A second Escape before then reaches the still-open palette.
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
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
  // The header title comes from the parse alone; the cover slide of a ready deck proves the deck rebuilt.
  await expect(page.locator(".reveal.ready .slides > section").first().locator("h1")).toHaveText(
    /\(edited\)$/,
  );

  // A code block taller than a slide is atomic: its page keeps an overflow note,
  // and the note must reach the gutter at its own section's heading (line 7), not elsewhere.
  const code = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
  await replaceSource(
    page,
    `# Notes doc\n\n## Short\n\nFine.\n\n## Config\n\nBefore.\n\n\`\`\`\n${code}\n\`\`\`\n`,
  );
  const marker = page.locator(".dw-note-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("title", /\(config\/\d+\)/);
  const noted = page.locator(".cm-line.dw-note-line");
  await expect(noted).toHaveCount(1);
  await expect(noted).toContainText("## Config");
});

for (const view of ["remote", "presenter"]) {
  test(`?view=${view} does not download the editor and deck app`, async ({ page }) => {
    // The phone remote is opened from a QR code, usually on cellular; the app
    // bundle (reveal.js, the parser, the sample doc) is ~180 KB gzip it never runs.
    const scripts: Promise<string>[] = [];
    page.on("response", (r) => {
      if (r.request().resourceType() === "script") scripts.push(r.text().catch(() => ""));
    });
    await page.goto(`/?view=${view}`);
    await page.waitForLoadState("networkidle");
    expect(scripts.length).toBeGreaterThan(0);
    // A string only App renders: present in whichever script carries App.
    const bodies = await Promise.all(scripts);
    const withApp = bodies.filter((b) => b.includes("Nothing uploaded · works offline"));
    expect(withApp.length, "scripts that carry App").toBe(0);
  });
}

test("the presenter window mirrors the deck and can drive it", async ({ page, context }) => {
  await ready(page);
  const popupPromise = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popupPromise;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The presenter drives the deck as soon as the slide it is on has a
  // preview, while the other previews are still being built: in WebKit the
  // popup shares this page's main thread, and a build in one long task held
  // up both the click and this page's answer to it.
  await expect(
    presenter.locator(".docwalk-presenter-current .docwalk-presenter-canvas"),
  ).toBeVisible();
  const before = await page.locator(".docwalk-preview-head strong").textContent();
  await presenter.getByRole("button", { name: /next/i }).first().click();
  await expect(page.locator(".docwalk-preview-head strong")).not.toHaveText(before ?? "");
});
