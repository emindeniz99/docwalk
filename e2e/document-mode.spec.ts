import { expect, test, type Page } from "@playwright/test";
import { opfsTest, ready } from "./helpers";

/**
 * Document mode as a reading view: it stays inside the window, the outline is
 * its table of contents, and on a phone the text gets the screen. Also the
 * header pieces that sit next to it (export status, workspace status).
 */

const PHONE = { width: 390, height: 844 };

/** Where a heading of the reading view sits, relative to the top of its scroll box. */
async function headingOffset(page: Page, id: string): Promise<number> {
  return page.evaluate((anchor) => {
    const pane = document.querySelector(".docwalk-document-pane")!;
    // The hidden deck carries the same heading ids; only the reading view's count.
    const heading = pane.querySelector(`[id="user-content-${anchor}"]`)!;
    return heading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, id);
}

const pageScroll = (page: Page) =>
  page.evaluate(() => ({
    top: document.documentElement.scrollTop,
    height: document.documentElement.scrollHeight,
    window: innerHeight,
  }));

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", PHONE],
] as const) {
  test(`document mode never scrolls the app out of the window (${name})`, async ({ page }) => {
    // The fixture has footnotes, whose visually hidden heading is positioned
    // absolutely. With nothing positioned around it, it was placed against
    // the page and stretched it to the document's full height, so End or a
    // wheel over the header scrolled header, outline and text out of view,
    // leaving a blank window.
    await page.setViewportSize(viewport);
    await ready(page);
    await page.getByRole("radio", { name: "Document" }).click();
    await expect(page.locator(".docwalk-document h2").first()).toBeVisible();
    // Focus is on the Document toggle, outside the reading pane.
    await page.keyboard.press("End");
    await page.mouse.move(viewport.width / 2, 20);
    await page.mouse.wheel(0, 3000);
    await expect.poll(async () => (await pageScroll(page)).top).toBe(0);
    const scroll = await pageScroll(page);
    expect(scroll.height).toBeLessThanOrEqual(scroll.window);
    await expect(page.locator(".docwalk-toolbar")).toBeInViewport();
  });
}

test("in document mode the outline scrolls the reading view to the section and stays in Document", async ({
  page,
}) => {
  // A reviewer uses the outline as a table of contents. It used to switch to
  // the source editor, which is not what a reader asked for.
  await ready(page);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(page.locator(".docwalk-document h2").first()).toBeVisible();
  await page.locator(".docwalk-outline-item", { hasText: "API" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "document");
  await expect.poll(() => headingOffset(page, "api")).toBeLessThan(40);
  expect(await headingOffset(page, "api")).toBeGreaterThanOrEqual(-1);
  await expect(page.locator(".docwalk-outline-item", { hasText: "API" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("entering document mode opens it at the section the outline marks as current", async ({
  page,
}) => {
  // Coming from a slide, the outline claimed one section while the reading
  // view sat at the top of the file.
  await ready(page);
  await page.locator(".docwalk-outline-item", { hasText: "Proposed architecture" }).click();
  await expect(page.locator(".docwalk-preview-address")).toHaveText(/^proposed-architecture\//);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect.poll(() => headingOffset(page, "proposed-architecture")).toBeLessThan(40);
  expect(await headingOffset(page, "proposed-architecture")).toBeGreaterThanOrEqual(-1);
});

for (const [hash, heading] of [
  ["#api/1", "api"],
  // A GitHub link to a sub-heading: the H3 sits inside the "Failure handling" slide.
  ["#clock-skew", "clock-skew"],
] as const) {
  test(`a link with ${hash} opens document mode at that heading`, async ({ page }) => {
    // A reviewer sends a link to one part of the doc. The reading view
    // opened at the top: the deck had no current slide yet when the link
    // switched to document mode, and the browser's own jump finds no
    // element, since heading ids carry GitHub's `user-content-` prefix.
    await page.goto(`/?view=document${hash}`);
    await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "document");
    await expect.poll(() => headingOffset(page, heading), { timeout: 30_000 }).toBeLessThan(40);
    expect(await headingOffset(page, heading)).toBeGreaterThanOrEqual(-1);
  });
}

test("on a 390 px phone the reading view gets most of the screen and the outline is a sheet", async ({
  page,
}) => {
  // The sidebar stayed a fixed block above the text and left it a strip of
  // about 350 px. The outline belongs in a sheet the reader opens on demand.
  await page.setViewportSize(PHONE);
  await ready(page);
  await page.getByRole("radio", { name: "Document" }).click();
  const pane = page.locator(".docwalk-document-pane");
  await expect(pane).toBeVisible();
  const box = await pane.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(PHONE.height * 0.7);
  await expect(page.locator(".docwalk-sidebar")).toHaveCount(0);
  // "Slides start at" changes nothing a reader sees here.
  await expect(page.getByText("Slides start at")).toHaveCount(0);

  await page.getByRole("button", { name: "Outline" }).click();
  const sheet = page.getByRole("dialog", { name: "Outline" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("option", { name: /^Security/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "document");
  await expect.poll(() => headingOffset(page, "security")).toBeLessThan(40);
  expect(await headingOffset(page, "security")).toBeGreaterThanOrEqual(-1);
});

test("the preview follows the cursor into a section typed just now", async ({ page }) => {
  // The cursor line was matched before the new heading had been paginated,
  // and nothing matched it again once it had: the preview stayed on the
  // previous slide while the author wrote the new one.
  await ready(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await expect(page.locator(".docwalk-preview-address")).toHaveText(/^changelog\//);
  await page.keyboard.type("\n\n## Added here\n\nhello\n");
  await expect(page.locator(".docwalk-preview-address")).toHaveText(/^added-here\//, {
    timeout: 10_000,
  });
});

test("the export status appears and fades without moving the header buttons", async ({ page }) => {
  // The empty status span was a flex item that took a gap; with text it left
  // the flow, so every export shifted the buttons 8 px under the pointer.
  await ready(page);
  const xs = () =>
    page
      .locator(".docwalk-toolbar :is(button, [role=radiogroup])")
      .evaluateAll((els) => els.slice(0, 5).map((el) => Math.round(el.getBoundingClientRect().x)));
  const trigger = page.getByRole("button", { name: "Export" });
  await expect(trigger).toBeEnabled();
  const before = await xs();
  const download = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download HTML" }).click();
  await download;
  await expect(page.locator(".docwalk-export-status")).not.toBeEmpty();
  expect(await xs()).toEqual(before);
});

opfsTest(
  "on a phone the Turkish save status of a workspace file stays clear of Present",
  async ({ page }) => {
    // "Bu tarayıcıda kaydedildi" ran on under the "Sunum yap" button.
    await page.setViewportSize(PHONE);
    await page.addInitScript(() => localStorage.setItem("docwalk.locale", "tr"));
    await page.goto("/");
    await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slayt/, {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Çalışma alanı işlemleri" }).click();
    await page.getByRole("menuitem", { name: "Yeni proje…" }).click();
    const dialog = page.getByRole("dialog", { name: "Yeni proje" });
    await dialog.getByLabel("Proje adı").fill("Telefon");
    await dialog.locator(".docwalk-ws-template", { hasText: "Tasarım belgesi" }).click();
    await dialog.getByRole("button", { name: "Projeyi oluştur" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".docwalk-ws-state")).toHaveText("Bu tarayıcıda kaydedildi");
    const state = await page.locator(".docwalk-ws-state").boundingBox();
    const present = await page.locator(".docwalk-present").boundingBox();
    expect((state?.x ?? 0) + (state?.width ?? 0)).toBeLessThanOrEqual(present?.x ?? 0);
  },
);
