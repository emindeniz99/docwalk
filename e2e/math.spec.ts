import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Math and emoji shortcodes (decision 101) in the built app: Temml and
 * gemoji are lazy chunks that only the production build splits, each
 * engine draws MathML itself, and a hostile formula must keep its source
 * on every engine without a request leaving the origin.
 */

const DOC = [
  "# Math check",
  "",
  "## Formulas",
  "",
  "Energy is $E = mc^2$ and a load $`a_b`$ :rocket:. It costs $5 and $10.",
  "",
  "$$",
  "\\frac{a}{b} = \\sqrt{x^2 + y^2}",
  "$$",
  "",
  "## Fence",
  "",
  "```math",
  "\\sum_{i=1}^{n} i",
  "```",
  "",
].join("\n");

const HOSTILE = [
  "# Hostile",
  "",
  "## Traps",
  "",
  "Image $\\includegraphics{https://trap.example/pixel.png}$ and style",
  "$\\style{background:url(https://trap.example/bg.png)}{x}$ and class $\\class{present}{y}$.",
  "",
  "$$",
  "\\def\\a{\\a\\a}\\a",
  "$$",
  "",
].join("\n");

const slide = (page: Page, id: string) =>
  page.locator(`.reveal .slides > section[data-docwalk-id='${id}']`);

/** Pastes `markdown` and waits for the rebuilt deck with `slides` slides. */
async function open(page: Page, markdown: string, slides: number, last: string) {
  await ready(page);
  await replaceSource(page, markdown);
  await expect(page.locator(".docwalk-statusbar")).toContainText(
    new RegExp(`(?<!\\d)${slides} slides`),
  );
  await expect(slide(page, last)).toHaveCount(1);
}

/** Requests the page makes to anything but its own origin, from now on. */
function foreignRequests(page: Page): string[] {
  const origin = new URL(page.url()).origin;
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      seen.push(url);
    }
  });
  return seen;
}

const isMathWorker = (url: string) =>
  /\/assets\/math\.worker-[^/]*\.js$/.test(new URL(url).pathname);

test("the math engine and the emoji list load only for a document that uses them", async ({
  page,
}) => {
  const chunks: string[] = [];
  page.on("request", (request) => {
    // The page half comes with its stylesheet: mathRender-….js and mathRender-….css.
    const file = /\/assets\/((?:mathRender|emojiMap)-[^/]*)$/.exec(new URL(request.url()).pathname);
    if (file?.[1]) chunks.push(file[1].replace(/-[^.]+\./, "."));
  });
  // The sample document has no formula and no shortcode (a timestamp is not one).
  await ready(page);
  await page.waitForLoadState("networkidle");
  expect(chunks).toEqual([]);
  expect(page.workers().filter((worker) => isMathWorker(worker.url()))).toEqual([]);
  // Temml is in the worker's script. Not every engine reports a worker's script request on
  // the page, so the worker itself is the witness.
  const worker = page.waitForEvent("worker", { predicate: (w) => isMathWorker(w.url()) });
  await replaceSource(page, DOC);
  await expect(slide(page, "formulas").locator("math").first()).toBeAttached();
  expect(isMathWorker((await worker).url())).toBe(true);
  expect(chunks.toSorted()).toEqual(["emojiMap.js", "mathRender.css", "mathRender.js"]);
});

test("formulas and shortcodes are drawn on the slides; dollar amounts stay text", async ({
  page,
}) => {
  await open(page, DOC, 3, "fence");
  const formulas = slide(page, "formulas");
  await expect(formulas.locator("p > math")).toHaveCount(2);
  await expect(formulas.locator("p > math msup")).toHaveCount(1);
  await expect(formulas.locator(".docwalk-math-display > math[display='block'] mfrac")).toHaveCount(
    1,
  );
  const text = formulas.locator(".docwalk-slide-body > p");
  await expect(text).toContainText("🚀");
  await expect(text).toContainText("It costs $5 and $10.");
  await expect(slide(page, "fence").locator(".docwalk-math-display munderover")).toHaveCount(1);
  await expect(page.locator(".reveal .slides code.language-math")).toHaveCount(0);
  // Each engine lays MathML out itself, so a pixel height would depend on its fonts and on
  // reveal.js's scale of the slide. A fraction has its numerator stacked above its denominator:
  // read all three boxes in one call (the scale cancels) and compare them with each other.
  const { fraction, numerator, denominator } = await formulas.locator("mfrac").evaluate((el) => {
    const box = (node: Element | undefined) => {
      const { top, bottom, height } = (node ?? el).getBoundingClientRect();
      return { top, bottom, height };
    };
    return {
      fraction: box(el),
      numerator: box(el.children[0]),
      denominator: box(el.children[1]),
    };
  });
  const message = JSON.stringify({ fraction, numerator, denominator });
  expect(numerator.height, message).toBeGreaterThan(0);
  expect(denominator.height, message).toBeGreaterThan(0);
  // The numerator ends where the denominator starts, give or take a pixel; drawn inline, the
  // two would sit side by side and overlap in height.
  expect(numerator.bottom, message).toBeLessThanOrEqual(denominator.top + 1);
  // The fraction holds both, one above the other (the bar and the gaps add to the sum).
  expect(fraction.height, message).toBeGreaterThanOrEqual(
    (numerator.height + denominator.height) * 0.9,
  );
});

test("a hostile formula keeps its source as text and nothing leaves the origin", async ({
  page,
}) => {
  await ready(page);
  const foreign = foreignRequests(page);
  await replaceSource(page, HOSTILE);
  await expect(page.locator(".docwalk-statusbar")).toContainText(/(?<!\d)2 slides/);
  const traps = slide(page, "traps");
  // Three inline sources and the display one, whose <pre> is marked too.
  await expect(traps.locator("code.docwalk-math-error")).toHaveCount(4);
  await expect(traps.locator("pre.docwalk-math-error")).toHaveCount(1);
  await expect(traps.locator("code.docwalk-math-error").first()).toHaveText(
    "\\includegraphics{https://trap.example/pixel.png}",
  );
  await expect(traps.locator("math, img, [style*='url'], .present")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(foreign).toEqual([]);
});

/** The re-review's bomb: a macro pasting its argument `r` times, called through a second `\def` `u` times. */
const bomb = (r: number, a: number, u: number) =>
  `\\def\\a#1{${"#1".repeat(r)}}\\def\\b{\\a{${"x".repeat(a)}}}${"\\b".repeat(u)}`;

test("a formula built to run for seconds leaves the deck responsive", async ({ page }) => {
  // 1,320 characters pasting 8.9 million tokens held the page for about 2 s in Chromium. The first
  // overflows a worker's stack on some engines and runs out the 500 ms deadline on others; the
  // second does not overflow in Chromium and runs to the deadline. Either way the page keeps drawing.
  const doc = [
    "# Bombs",
    "",
    "## Formulas",
    "",
    `$${bomb(100, 900, 99)}$`,
    "",
    `$${bomb(70, 900, 99)}$`,
    "",
    "$x+y$",
    "",
  ].join("\n");
  await ready(page);
  // The longest time the page goes without a frame while it builds the deck that holds the
  // formulas: from the moment they are in the page, as source, until reveal.js has the
  // finished pages. Replacing the 52-slide sample in the editor comes before that and is not
  // the formulas' work: with the CPU slowed six times it held Chromium's page for 250 to
  // 530 ms, the same with no formula in the new document.
  await page.evaluate(() => {
    const frames = { longest: 0, gaps: [] as string[], started: false, ended: false };
    (window as unknown as { dwFrames: typeof frames }).dwFrames = frames;
    const toDraw = ".reveal code.language-math:not(.docwalk-math-error)";
    let start = 0;
    let last = 0;
    const count = () => {
      const now = performance.now();
      const gap = now - last;
      frames.longest = Math.max(frames.longest, gap);
      if (gap >= 100) {
        frames.gaps.push(
          `${Math.round(gap)} ms at ${Math.round(last - start)} ms, ${document.querySelectorAll(toDraw).length} still to draw`,
        );
      }
      last = now;
    };
    const tick = () => {
      if (frames.ended) return;
      if (frames.started) count();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // A change of the page is seen before the next frame, so a formula that holds the thread
    // from the moment it arrives is counted, and so is one that holds it until the deck is ready.
    const observer = new MutationObserver(() => {
      if (!frames.started) {
        if (!document.querySelector(toDraw)) return;
        frames.started = true;
        start = last = performance.now();
      } else if (document.querySelector(".reveal.ready")) {
        count();
        frames.ended = true;
        observer.disconnect();
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  });
  await replaceSource(page, doc);
  const formulas = slide(page, "formulas");
  await expect(formulas.locator("p > math")).toHaveCount(1, { timeout: 15_000 });
  await expect(formulas.locator("code.docwalk-math-error")).toHaveCount(2);
  const read = () =>
    page.evaluate(
      () =>
        (window as unknown as { dwFrames: { longest: number; gaps: string[]; ended: boolean } })
          .dwFrames,
    );
  // The recorder has to have seen the formulas arrive and the deck finish, or it measured nothing.
  await expect.poll(async () => (await read()).ended).toBe(true);
  const { longest, gaps } = await read();
  expect(longest, `gaps of 100 ms or more: ${gaps.join("; ") || "none"}`).toBeLessThan(500);
});

test("document mode draws the formulas and the shortcode", async ({ page }) => {
  await open(page, DOC, 3, "fence");
  await page.getByRole("radio", { name: "Document" }).click();
  const doc = page.locator(".docwalk-document");
  await expect(doc.locator("p > math")).toHaveCount(2);
  await expect(doc.locator(".docwalk-math-display > math")).toHaveCount(2);
  await expect(doc.locator("p").first()).toContainText("🚀");
});

test("the HTML export keeps the formulas as MathML", async ({ page, context }) => {
  await open(page, DOC, 3, "fence");
  await expect(slide(page, "formulas").locator("mfrac")).toBeAttached();
  const trigger = page.getByRole("button", { name: "Export" });
  await expect(trigger).toBeEnabled();
  const download = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download HTML" }).click();
  const html = await readFile(await (await download).path(), "utf8");
  expect(html).not.toMatch(/<script/i);
  // Opened with nothing from docwalk around it: the formulas must be in the file.
  const file = await context.newPage();
  await file.setContent(html);
  await expect(file.locator(".docwalk-export-page math")).toHaveCount(4);
  await expect(file.locator(".docwalk-export-page mfrac")).toHaveCount(1);
  await expect(file.getByRole("article", { name: "Slide 2 of 3" })).toContainText("🚀");
});
