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

test("the math engine and the emoji list load only for a document that uses them", async ({
  page,
}) => {
  const chunks: string[] = [];
  page.on("request", (request) => {
    // Temml's chunk comes with its stylesheet: mathBuild-….js and mathBuild-….css.
    const file = /\/assets\/((?:mathBuild|emojiMap)-[^/]*)$/.exec(new URL(request.url()).pathname);
    if (file?.[1]) chunks.push(file[1].replace(/-[^.]+\./, "."));
  });
  // The sample document has no formula and no shortcode (a timestamp is not one).
  await ready(page);
  await page.waitForLoadState("networkidle");
  expect(chunks).toEqual([]);
  await replaceSource(page, DOC);
  await expect(slide(page, "formulas").locator("math").first()).toBeAttached();
  expect(chunks.toSorted()).toEqual(["emojiMap.js", "mathBuild.css", "mathBuild.js"]);
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
  // Each engine lays MathML out itself: a fraction is taller than its line of text.
  const height = await formulas
    .locator("mfrac")
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(20);
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
