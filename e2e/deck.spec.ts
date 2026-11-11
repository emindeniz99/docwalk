import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Deck follow-ups: the slide overview, per-slide annotation history, notes in
 * the presenter previews, and short sub-heading parts sharing a slide. Each
 * test guards what a presenter would notice in the assembled app.
 */

const hash = (page: Page) => page.evaluate(() => location.hash);
const overview = (page: Page) => page.getByRole("dialog", { name: "Slide overview" });
const rows = (page: Page) => overview(page).getByRole("grid", { name: "Slides" }).getByRole("row");
const focusedKey = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-key") ?? null);

test("the overview opens on the current slide, arrow keys move, Enter jumps there and closes", async ({
  page,
}) => {
  await ready(page, "/#summary/1");
  const total = Number(
    (await page.locator(".docwalk-statusbar").textContent())?.match(/(\d+) slides/)?.[1],
  );
  await page.getByRole("button", { name: "Slide overview" }).click();
  await expect(overview(page)).toBeVisible();
  // Every paginated page is there, not one per section: a split section shows all its pages.
  await expect(rows(page)).toHaveCount(total);
  // Keyboard users start from where the talk is, not from slide 1.
  await expect.poll(() => focusedKey(page)).toBe("summary/1");
  // A screen reader hears which slide is which, and which one the room sees.
  await expect(page.locator(":focus")).toHaveAccessibleName(
    `Summary, slide 2 of ${total}, current slide`,
  );

  await page.keyboard.press("ArrowRight");
  const target = await focusedKey(page);
  expect(target).not.toBe("summary/1");
  await page.keyboard.press("Enter");
  await expect(overview(page)).toBeHidden();
  await expect.poll(() => hash(page)).toBe(`#${target}`);
});

test("O opens the overview while presenting; Escape closes it without leaving present mode", async ({
  page,
}) => {
  await ready(page, "/#summary/1");
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await page.locator(".reveal").focus();
  await page.keyboard.press("o");
  await expect(overview(page)).toBeVisible();
  // reveal.js's own overview (a zoomed-out deck with no names) must stay off.
  await expect(page.locator(".reveal.overview")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(overview(page)).toBeHidden();
  // The room keeps seeing the same slide, still in present mode.
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await expect.poll(() => hash(page)).toBe("#summary/1");
  // Focus goes back to the deck, so the arrow keys keep driving it.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => hash(page)).not.toBe("#summary/1");
});

test("typing O in the editor writes the letter and does not open the overview", async ({
  page,
}) => {
  await ready(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("o");
  await expect(overview(page)).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText(/o$/);
});

test("the open overview passes axe (WCAG 2.2 AA)", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Slide overview" }).click();
  await expect(rows(page).first()).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
});

test("the open overview repeats no id of the deck and its diagram thumbnails keep their styles", async ({
  page,
}) => {
  // The thumbnails are copies of the pages, so every heading, footnote and
  // diagram id appeared twice while the overview was open. Mermaid's <style>
  // selects by the SVG's id and its arrows reach their markers by id, so the
  // copies rename their ids instead of dropping them (decision 108).
  await ready(page);
  await replaceSource(
    page,
    [
      "## First point",
      "",
      "A claim with a source.[^one]",
      "",
      "[^one]: The source.",
      "",
      "## Flow",
      "",
      "```mermaid",
      "flowchart LR",
      "  client[Client] --> api[API]",
      "  api --> store[(Store)]",
      "```",
      "",
      "## Second point",
      "",
      "Another claim.[^two]",
      "",
      "[^two]: Another source.",
      "",
    ].join("\n"),
  );
  await expect(page.locator(".docwalk-statusbar")).toContainText(/(?<!\d)3 slides/);
  await expect(page.locator(".reveal .slides .docwalk-diagram svg")).toHaveCount(1);
  const repeated = () =>
    page.evaluate(() => {
      const seen = new Map<string, number>();
      for (const el of document.querySelectorAll("[id]"))
        seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
      return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    });
  expect(await repeated()).toEqual([]);

  await page.getByRole("button", { name: "Slide overview" }).click();
  await expect(rows(page)).toHaveCount(3);
  // The copies keep ids (footnotes, headings, the diagram and its markers), none of them repeated.
  expect(await page.locator(".docwalk-overview-canvas [id]").count()).toBeGreaterThan(10);
  expect(await repeated()).toEqual([]);

  const thumbnail = await page.evaluate(() => {
    const slide = document.querySelector(".reveal .slides .docwalk-diagram svg");
    const copy = document.querySelector(".docwalk-overview-canvas .docwalk-diagram svg");
    if (!slide || !copy) return null;
    const [slideFill, copyFill] = [slide, copy].map((svg) => {
      const shape = svg.querySelector(".node rect, .node path, .node polygon");
      return shape ? getComputedStyle(shape).fill : null;
    });
    // Each arrow's marker must be the copy's own, not the slide's.
    const markers = [...copy.querySelectorAll("[marker-end], [marker-start]")].flatMap((el) =>
      ["marker-end", "marker-start"]
        .map((name) => /url\(#(.+)\)/.exec(el.getAttribute(name) ?? "")?.[1])
        .filter((id): id is string => id !== undefined)
        .map((id) => copy.contains(document.getElementById(id))),
    );
    return { slide: slideFill, copy: copyFill, markers };
  });
  // Mermaid's default theme fills a node lavender; without its style the shape draws black.
  expect(thumbnail?.slide).not.toBe("rgb(0, 0, 0)");
  expect(thumbnail?.copy).toBe(thumbnail?.slide);
  expect(thumbnail?.markers.length).toBeGreaterThan(0);
  expect(thumbnail?.markers.every(Boolean)).toBe(true);
});

test("on a phone the overview fills the screen with two thumbnails per row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  // A phone's edit view shows source or preview; the overview button is on the preview.
  await page.getByRole("radio", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Slide overview" }).click();
  const [a, b] = await Promise.all([
    rows(page).nth(0).boundingBox(),
    rows(page).nth(1).boundingBox(),
  ]);
  expect(a && b && Math.abs(a.y - b.y)).toBeLessThan(2);
  const dialog = await overview(page).boundingBox();
  expect(dialog?.width).toBeGreaterThanOrEqual(389);
  // No sideways scroll on a phone.
  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowX).toBeLessThanOrEqual(0);
});

test("undo still works on a slide after stepping away and back", async ({ page }) => {
  await ready(page, "/#summary/1");
  await page.getByRole("radio", { name: "Pen" }).click();
  const r = await page.locator(".docwalk-annotate").boundingBox();
  if (!r) throw new Error("annotation overlay missing");
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.65, { steps: 12 });
  await page.mouse.up();
  const marks = page.locator(".docwalk-annotate-draw > *").filter({ visible: true });
  await expect(marks).toHaveCount(1);

  await page.locator(".reveal").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(marks).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(marks).toHaveCount(0);
});

test("the presenter window's preview shows the slide's overflow note", async ({
  page,
  context,
}) => {
  await ready(page);
  const code = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
  await replaceSource(
    page,
    `# Notes doc\n\n## Short\n\nFine.\n\n## Config\n\n\`\`\`\n${code}\n\`\`\`\n`,
  );
  // Wait for the rebuilt deck: a click on the old one would be undone by the rebuild.
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);
  // The status bar names the kind of note: speaker notes are notes too (decision 130).
  await expect(page.locator(".docwalk-statusbar")).toContainText(/(?<!\d)1 overflow note(?!s)/);
  await page.getByRole("option", { name: /Config/ }).click();
  await expect.poll(() => hash(page)).toBe("#config/1");

  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByRole("figure", { name: /^Now/ })).toContainText("Config", {
    timeout: 30_000,
  });
  const note = presenter.locator(".docwalk-presenter-current .docwalk-overflow");
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toContainText("Does not fit");
});

test("the presenter window downloads no reveal.js", async ({ page }) => {
  // It rebuilds pages to preview them and never runs reveal; reveal.js and
  // its CSS used to ride along in a chunk shared with the app.
  const scripts: Promise<string>[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "script") scripts.push(r.text().catch(() => ""));
  });
  await page.goto("/?view=presenter");
  await page.waitForLoadState("networkidle");
  const bodies = await Promise.all(scripts);
  expect(bodies.length).toBeGreaterThan(0);
  // "slidechanged" is reveal.js's own event name.
  expect(bodies.filter((b) => b.includes("slidechanged"))).toEqual([]);
});

test("short sub-heading parts of a split section share one slide", async ({ page }) => {
  // The fixture's "Failure handling" overflows; its three short parts used
  // to take three slides and now sit on its third page together.
  await ready(page, "/#failure-handling/3");
  const slide = page.locator(".reveal .slides > section.present");
  await expect(slide.locator("h3")).toHaveText([
    "Poison messages",
    "Partial failures",
    "Duplicate delivery",
  ]);
});
