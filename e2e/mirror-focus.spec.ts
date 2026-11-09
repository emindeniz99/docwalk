import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource } from "./helpers";

/**
 * Mirroring the code, table and image focus views and their line marks
 * (decision 106) across real pages, with the relay played by `fakeRelay` as
 * in mirror.spec.ts. The follower is smaller than the presenter on purpose:
 * zoom travels as a share of each screen's own Fit and scroll as a share of
 * how far each can scroll, so the numbers differ and the framing matches.
 */

const SHOTS = process.env["DOCWALK_SHOTS"];
const REMOTE = "https://images.invalid/chart.png";
// The app's own icon, so the stubbed remote image has a real size.
const PNG = readFileSync(new URL("../public/icons/icon-192.png", import.meta.url));

function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A grey, vertically graded PNG of the given size, made here so no fixture file is needed. */
function tallPng(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grey, deflate, no filter, no interlace
  // Each row: filter byte 0, then the pixels.
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    rows.fill(Math.round((y / height) * 200), y * (width + 1) + 1, (y + 1) * (width + 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Tall enough that the loaded image beats the placeholder by more than one listing,
// short enough that a slide still holds it with its heading (a slide body is ~612px).
const TALL_HEIGHT = 400;

const cell = (i: number) => `${"w".repeat(11)}${i % 10}`;
const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const HEAD = Array.from({ length: 16 }, (_, i) => cell(i));

const DOC = [
  "# Focus talk",
  "",
  "## Code",
  "",
  "```ts",
  "export function retry(attempt: number): number {",
  "  const base = 200;",
  "",
  "  return base * 2 ** attempt;",
  "}",
  "```",
  "",
  "## Table",
  "",
  // One body row: pagination gives each row of a table this wide a page of its own.
  row(HEAD),
  row(HEAD.map(() => "---")),
  row(HEAD),
  "",
  "## Logo",
  "",
  "![Company logo](/icons/icon-192.png)",
  "",
  "## Chart",
  "",
  `![Chart](${REMOTE})`,
  "",
  "```text",
  "after the chart",
  "```",
  "",
].join("\n");
const SLIDES = 5;

const view = (page: Page) => page.locator(".docwalk-focus");
const present = (page: Page) => page.locator(".reveal .slides > section.present");
const lines = (page: Page) => view(page).locator(".docwalk-code-line");

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The type size of an open code or table view (`--focus-scale`). */
const typeScale = (page: Page) =>
  view(page)
    .locator(".docwalk-focus-sheet")
    .evaluate((sheet) => Number((sheet as HTMLElement).style.getPropertyValue("--focus-scale")));

/** How far the open text view is scrolled across, as a share of how far it can scroll. */
const scrolledAcross = (page: Page) =>
  view(page)
    .locator(".docwalk-focus-stage")
    .evaluate((stage) => stage.scrollLeft / Math.max(1, stage.scrollWidth - stage.clientWidth));

/** The scale Panzoom gives a canvas view. */
async function canvasScale(page: Page) {
  const style = (await view(page).locator(".docwalk-focus-canvas").getAttribute("style")) ?? "";
  return Number(/scale\(([\d.]+)\)/.exec(style)?.[1] ?? "1");
}

/** Which code lines of the open view are marked, from 1. */
const marked = (page: Page) =>
  lines(page).evaluateAll((all) =>
    all.flatMap((line, i) => (line.getAttribute("aria-pressed") === "true" ? [i + 1] : [])),
  );

async function openPresenterRoom(
  context: BrowserContext,
  options: { doc?: string; slides?: number; before?: (page: Page) => Promise<void> } = {},
) {
  const presenter = await context.newPage();
  await options.before?.(presenter);
  await ready(presenter);
  await replaceSource(presenter, options.doc ?? DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(options.slides ?? SLIDES);
  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  return { presenter, followUrl };
}

async function openFollower(
  context: BrowserContext,
  url: string,
  options: {
    size?: { width: number; height: number };
    /** Pages differ between screens that paginate differently; null accepts any count. */
    slides?: number | null;
    before?: (page: Page) => Promise<void>;
  } = {},
) {
  const follower = await context.newPage();
  await follower.setViewportSize(options.size ?? { width: 900, height: 600 });
  await options.before?.(follower);
  await ready(follower, url);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText(
    options.slides === null ? /\/ \d+$/ : new RegExp(`/ ${options.slides ?? SLIDES}$`),
  );
  return follower;
}

/** Moves the presenter to the slide titled `title` and waits for the follower to get there. */
async function goTo(presenter: Page, follower: Page, title: string, at: number) {
  await presenter.getByRole("option", { name: new RegExp(title) }).click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText(`${at} / ${SLIDES}`);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText(`${at} / ${SLIDES}`);
}

async function openBlock(page: Page, block: Locator, kind: string) {
  await block.click();
  await expect(view(page)).toHaveAttribute("data-kind", kind);
}

test("a follower opens the presenter's code view with two marked lines, follows its zoom and closes with it", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await goTo(presenter, follower, "Code", 2);

  await openBlock(presenter, present(presenter).locator("pre"), "code");
  await expect(view(follower)).toHaveAttribute("data-kind", "code");
  await expect(lines(follower)).toHaveCount(5);
  const presenterFit = await typeScale(presenter);
  const followerFit = await typeScale(follower);

  await lines(presenter).nth(0).click();
  await lines(presenter).nth(3).click();
  await expect.poll(() => marked(follower)).toEqual([1, 4]);

  // Zoom travels as a share of Fit: each screen zooms from its own.
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  const ratio = (await typeScale(presenter)) / presenterFit;
  expect(ratio).toBeGreaterThan(1.1);
  await expect
    .poll(async () => Math.abs((await typeScale(follower)) / followerFit - ratio))
    .toBeLessThan(0.01);
  await shot(follower, "follower-code-marked");

  // Clear on the presenter clears the follower's marks too.
  await presenter.getByRole("button", { name: "Clear all marked lines" }).click();
  await expect.poll(() => marked(follower)).toEqual([]);
  await view(presenter).getByRole("button", { name: "Close" }).click();
  await expect(view(presenter)).toHaveCount(0);
  await expect(view(follower)).toHaveCount(0);
});

test("a follower's table view scrolls with the presenter's, as a share of how far each can scroll", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await goTo(presenter, follower, "Table", 3);

  await openBlock(presenter, present(presenter).locator("table"), "table");
  await expect(view(follower)).toHaveAttribute("data-kind", "table");
  const stage = view(presenter).locator(".docwalk-focus-stage");
  const reach = await stage.evaluate((s) => s.scrollWidth - s.clientWidth);
  expect(reach, "the presenter's table scrolls sideways").toBeGreaterThan(200);

  // A plain wheel scrolls the text views natively; Ctrl or Cmd would zoom.
  await stage.hover();
  await presenter.mouse.wheel(reach * 0.6, 0);
  await expect.poll(() => scrolledAcross(presenter)).toBeGreaterThan(0.3);
  const across = await scrolledAcross(presenter);
  await expect
    .poll(async () => Math.abs((await scrolledAcross(follower)) - across))
    .toBeLessThan(0.02);
  await shot(follower, "follower-table-scrolled");

  await presenter.keyboard.press("Escape");
  await expect(view(follower)).toHaveCount(0);
});

test("a follower opens the presenter's image view on its own loaded copy and follows its zoom", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await goTo(presenter, follower, "Logo", 4);

  await openBlock(presenter, present(presenter).locator("img"), "image");
  await expect(view(follower)).toHaveAttribute("data-kind", "image");
  await expect(view(follower).locator("img")).toHaveJSProperty("complete", true);
  await expect(view(follower).locator("img")).toHaveAttribute("alt", "Company logo");

  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => canvasScale(presenter)).toBeGreaterThan(1.3);
  await expect.poll(() => canvasScale(follower)).toBeGreaterThan(1.3);
  await shot(follower, "follower-image");

  await presenter.keyboard.press("Escape");
  await expect(view(follower)).toHaveCount(0);
});

test("an image the follower has not loaded stays blocked and unrequested when the presenter opens it", async ({
  context,
}) => {
  // Decision 33 is the gate, and mirroring is not a way past it (decision 106):
  // the presenter loads the remote image, the follower never asks for it.
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  await presenter.route(REMOTE, (route) => route.fulfill({ body: PNG, contentType: "image/png" }));
  const asked: string[] = [];
  const errors: string[] = [];
  const follower = await openFollower(context, followUrl, {
    before: async (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("https://images.invalid/**", (route) => {
        asked.push(route.request().url());
        return route.abort();
      });
    },
  });
  await goTo(presenter, follower, "Chart", 5);

  const chart = present(presenter).locator("img");
  await chart.click();
  await expect(chart).toHaveAttribute("data-docwalk-focus", "image");
  await openBlock(presenter, chart, "image");
  await presenter.getByRole("button", { name: "Zoom in" }).click();

  // The code view on the same slide shows the ops arrived, and in order.
  await presenter.keyboard.press("Escape");
  await openBlock(presenter, present(presenter).locator("pre"), "code");
  await expect(view(follower)).toHaveAttribute("data-kind", "code");
  const theirs = present(follower).locator("img");
  await expect(theirs).toHaveClass(/docwalk-blocked-image/);
  expect(await theirs.getAttribute("src")).toBeNull();
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
  await shot(follower, "follower-image-blocked");
});

test("a follower that joins late gets the open code view, its zoom and its marked lines", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  await presenter.getByRole("option", { name: /Code/ }).click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText(`2 / ${SLIDES}`);
  await openBlock(presenter, present(presenter).locator("pre"), "code");
  const presenterFit = await typeScale(presenter);
  await lines(presenter).nth(1).click();
  await lines(presenter).nth(4).click();
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  const ratio = (await typeScale(presenter)) / presenterFit;

  // The presenter's page is inert behind its view; the room answers the newcomer all the same.
  const late = await openFollower(context, followUrl, { size: { width: 700, height: 500 } });
  await expect(late.locator(".docwalk-preview-head strong")).toHaveText(`2 / ${SLIDES}`);
  await expect(view(late)).toHaveAttribute("data-kind", "code");
  // The marks come last in a resync, so the zoom before them has arrived too.
  await expect.poll(() => marked(late)).toEqual([2, 5]);
  const zoomed = await typeScale(late);
  await shot(late, "late-follower-code");

  // Its zoom is the presenter's share of Fit, on this screen's own Fit.
  await late.getByRole("button", { name: "Fit to screen" }).click();
  const fit = await typeScale(late);
  expect(Math.abs(zoomed / fit - ratio)).toBeLessThan(0.01);
});

/**
 * Which listings each page of the Chart section holds on this screen, by page
 * number from 1, read from the rendered pages: a listing starts "XXX first".
 */
const listingsByPage = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.reveal .slides > section[data-docwalk-id="chart"]',
      ),
    ]
      .map((section) => ({
        page: Number(section.dataset["page"] ?? "1"),
        names: [...section.querySelectorAll("pre")].flatMap((pre) => {
          const name = /^(\w{3}) first/.exec(pre.textContent ?? "")?.[1];
          return name ? [name] : [];
        }),
      }))
      .toSorted((a, b) => a.page - b.page)
      .map((entry) => entry.names),
  );

/**
 * How tall, in slide CSS pixels, the Chart section's picture is on this screen
 * (the loaded image or its placeholder, with the paragraph around it) and how
 * tall its tallest listing is with both margins. Layout sizes, so the scale
 * reveal.js gives the slides does not enter.
 */
const chartHeights = (page: Page) =>
  page.evaluate(() => {
    const section = document.querySelector<HTMLElement>(
      '.reveal .slides > section[data-docwalk-id="chart"]',
    )!;
    const picture = section.querySelector<HTMLElement>(".docwalk-blocked-frame, img")!;
    const flow = picture.closest<HTMLElement>("p") ?? picture;
    const tallest = Math.max(
      ...[
        ...document.querySelectorAll<HTMLElement>('.reveal section[data-docwalk-id="chart"] pre'),
      ].map((pre) => {
        const style = getComputedStyle(pre);
        return pre.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      }),
    );
    return { picture: picture.offsetHeight, flow: flow.offsetHeight, tallest };
  });

/**
 * The Chart section's pages on this screen as they stand: how far each overflows its slide
 * body, measured on a slide-sized copy once that copy's images have loaded (the way the
 * deck measures, but waiting), and whether its note shows; each picture in the section;
 * and the "always load" setting in storage now.
 */
const deckState = (page: Page) =>
  page.evaluate(async () => {
    const sections = [
      ...document.querySelectorAll<HTMLElement>(
        '.reveal .slides > section[data-docwalk-id="chart"]',
      ),
    ];
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      width: "1280px",
      height: "720px",
      visibility: "hidden",
      contain: "strict",
    });
    document.body.append(box);
    const pages = [];
    for (const section of sections) {
      const copy = section.querySelector(".docwalk-slide")!.cloneNode(true) as HTMLElement;
      box.replaceChildren(copy);
      await Promise.all(
        [...copy.querySelectorAll("img[src]")].map((img) =>
          (img as HTMLImageElement).decode().catch(() => undefined),
        ),
      );
      const body = copy.querySelector<HTMLElement>(".docwalk-slide-body")!;
      pages.push({
        page: Number(section.dataset["page"] ?? "1"),
        overflow: body.scrollHeight - body.clientHeight,
        note: section.querySelector<HTMLElement>(".docwalk-overflow")?.hidden === false,
      });
    }
    box.remove();
    const images = sections.flatMap((section) =>
      [...section.querySelectorAll("img")].map((img) => ({
        page: Number(section.dataset["page"] ?? "1"),
        src: img.getAttribute("src"),
        blocked: img.classList.contains("docwalk-blocked-image"),
        complete: img.complete,
        naturalHeight: img.naturalHeight,
        height: img.offsetHeight,
        sizeAttributes: [img.getAttribute("width"), img.getAttribute("height")],
      })),
    );
    let setting: string | null;
    try {
      setting = localStorage.getItem("docwalk.loadRemoteImages");
    } catch {
      setting = "unreadable";
    }
    return { pages, images, setting };
  });

const pageNumber = (page: Page) =>
  present(page).evaluate((el) => Number(el.dataset["page"] ?? "1"));

const listing = (page: Page, name: string) =>
  present(page)
    .locator("pre")
    .filter({ hasText: `${name} first` });

test("a follower whose pages are cut elsewhere opens the listing the presenter opened, or nothing, never another", async ({
  context,
}) => {
  // Decision 106: listings never split, so they are numbered across the section.
  // The presenter loads the remote image before pagination and the follower
  // blocks it, so its placeholder is shorter and the pages are cut differently.
  // The image is tall on purpose: with the 192px icon one engine absorbed the
  // difference in the room each page has left, and both screens cut alike.
  // Where each engine puts the cuts is its own, so the test reads both screens'
  // pages from the DOM and picks the listings to open from what they hold.
  const listings = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].flatMap((name) => [
    "```text",
    `${name} first`,
    ...[2, 3, 4, 5].map((i) => `${name} line ${i}`),
    "```",
    "",
  ]);
  const doc = ["# Pages talk", "", "## Chart", "", `![Chart](${REMOTE})`, "", ...listings].join(
    "\n",
  );
  const REMOTE_KEY = "docwalk.loadRemoteImages";
  const TALL = tallPng(200, TALL_HEIGHT);
  // How often the presenter's page asked for the image: more than once means copies of it
  // loaded it again (Playwright's routing turns the HTTP cache off).
  let imageRequests = 0;
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context, {
    doc,
    slides: 2,
    before: async (page) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.addInitScript((key) => localStorage.setItem(key, "true"), REMOTE_KEY);
      await page.route(REMOTE, (route) => {
        imageRequests++;
        return route.fulfill({ body: TALL, contentType: "image/png" });
      });
    },
  });
  const follower = await openFollower(context, followUrl, {
    size: { width: 1280, height: 720 },
    slides: null,
    before: async (page) => {
      // The storage is shared with the presenter's page: this one starts without the setting,
      // and records the text of every focus view that opens on it. The presenter read the
      // setting once when it started, so removing it here changes only this page.
      await page.addInitScript((key) => {
        try {
          localStorage.removeItem(key);
        } catch {
          // No storage, no setting.
        }
        const opened: string[] = [];
        (window as unknown as { openedFocusViews: string[] }).openedFocusViews = opened;
        new MutationObserver((records) => {
          for (const node of records.flatMap((r) => [...r.addedNodes])) {
            if (node instanceof HTMLElement && node.classList.contains("docwalk-focus"))
              opened.push(node.querySelector(".docwalk-focus-stage")?.textContent ?? "");
          }
        }).observe(document, { childList: true, subtree: true });
      }, REMOTE_KEY);
      await page.route("https://images.invalid/**", (route) => route.abort());
    },
  });

  // The cuts can only differ if the two pictures differ by more than a page can leave
  // unused. A page stops short of the next listing, so it leaves less than one listing
  // and its margins empty; a gap taller than that moves at least one listing from one
  // page to the next, on every engine, whatever its line heights.
  const loaded = await chartHeights(presenter);
  const blocked = await chartHeights(follower);
  const gap = loaded.picture - blocked.picture;
  const slack = Math.max(loaded.tallest, blocked.tallest);
  test.info().annotations.push({
    type: "heights",
    description: `loaded image ${loaded.picture}px, placeholder ${blocked.picture}px, gap ${gap}px, tallest listing with margins ${slack}px`,
  });
  expect(
    gap,
    `the loaded image (${loaded.picture}px) must be taller than the placeholder (${blocked.picture}px) by more than the tallest listing with its margins (${slack}px)`,
  ).toBeGreaterThan(slack);

  // How the presenter's deck stands now that its image has loaded: each page measured with
  // that image, whether it shows its note, and the image itself. Rule 3: a page that does
  // not fit says so. Pagination that measured the image before it had its size cuts like
  // the follower and puts more on the image's page than fits.
  const requested = imageRequests;
  const state = { ...(await deckState(presenter)), imageRequests: requested };
  test.info().annotations.push({ type: "presenter", description: JSON.stringify(state) });
  expect(
    state.pages.filter((p) => p.overflow > 4 && !p.note),
    `every presenter page fits or shows its note (presenter ${JSON.stringify(state)})`,
  ).toEqual([]);

  // What each screen's pages hold. If they were cut alike, no follower could open a
  // listing the wrong way and the case would prove nothing.
  const theirs = await listingsByPage(follower);
  const ours = await listingsByPage(presenter);
  test.info().annotations.push({
    type: "pages",
    description: `presenter ${JSON.stringify(ours)}, follower ${JSON.stringify(theirs)}`,
  });
  expect(theirs, "the follower's pages hold the listings").not.toEqual([]);
  expect(
    JSON.stringify(theirs),
    `this screen cuts the pages elsewhere, or the case proves nothing (presenter ${JSON.stringify(ours)}, its deck ${JSON.stringify(state)})`,
  ).not.toBe(JSON.stringify(ours));

  // Pick a page both screens have where the presenter holds a listing the follower's page
  // lacks (it must open nothing) and one it has (it must open that very listing).
  const choices = ours.flatMap((names, i) => {
    const there = theirs[i] ?? [];
    const absent = names.find((name) => !there.includes(name));
    const shared = names.find((name) => there.includes(name));
    return absent && shared ? [{ n: i + 1, absent, shared }] : [];
  });
  expect(
    choices,
    `a page where the follower has one of the presenter's listings and lacks another (presenter ${JSON.stringify(ours)}, follower ${JSON.stringify(theirs)})`,
  ).not.toEqual([]);
  const { n, absent, shared } = choices[0]!;

  // Both on page n of the section.
  await presenter.getByRole("option", { name: /Chart/ }).click();
  await presenter.locator(".reveal").focus();
  for (let i = 1; i < n; i++) await presenter.keyboard.press("ArrowRight");
  await expect.poll(() => pageNumber(presenter)).toBe(n);
  await expect.poll(() => pageNumber(follower)).toBe(n);
  await expect(listing(presenter, absent)).toBeVisible();
  await expect(listing(presenter, shared)).toBeVisible();
  await expect(listing(follower, absent), "the follower's page lacks it").toHaveCount(0);
  await expect(listing(follower, shared), "the follower's page has it").toHaveCount(1);

  // The first is on another of the follower's pages: it opens nothing, and above all not
  // the listing that happens to be first on the page it shows.
  await openBlock(presenter, listing(presenter, absent), "code");
  await presenter.keyboard.press("Escape");
  await expect(view(presenter)).toHaveCount(0);

  // The second is on the follower's page too. When it opens, the earlier ops have been handled.
  await openBlock(presenter, listing(presenter, shared), "code");
  await expect(view(follower)).toHaveAttribute("data-kind", "code");
  await expect(view(follower).locator(".docwalk-focus-stage")).toContainText(`${shared} first`);
  const opened = await follower.evaluate(
    () => (window as unknown as { openedFocusViews: string[] }).openedFocusViews,
  );
  expect(opened.map((text) => text.slice(0, 9))).toEqual([`${shared} first`]);
});
