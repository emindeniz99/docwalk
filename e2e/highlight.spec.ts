import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { tokens } from "../src/design/tokens";
import { ready, replaceSource } from "./helpers";

/**
 * Code colours (decision 76) in the built app, on every engine: the
 * highlighter and its grammars are separate chunks that only the production
 * build splits, and each engine runs Shiki's translated regular expressions
 * with its own regex implementation.
 */

const SOURCE = 'const retries: number = 3; // budget\nexport const label = "ledger";';
const DOC = [
  "# Code check",
  "",
  "## Retry code",
  "",
  "```ts",
  SOURCE,
  "```",
  "",
  "## Patch",
  "",
  "```diff",
  "-const retries = 2;",
  "+const retries = 3;",
  "```",
  "",
].join("\n");

const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};
const colour = (el: Locator, property = "color") =>
  el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), property);
const present = (page: Page) => page.locator(".reveal .slides > section.present");

async function openDoc(page: Page) {
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.locator(".reveal .slides > section[data-docwalk-id='patch']")).toHaveCount(1);
}

test("a highlighted block renders in present mode, with its text unchanged", async ({ page }) => {
  await openDoc(page);
  await page.evaluate(() => {
    window.location.hash = "#retry-code";
  });
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  const code = present(page).locator("pre > code");
  const keyword = code.locator(".dw-code-keyword").first();
  await expect(keyword).toHaveText("const");
  expect(await colour(keyword)).toBe(rgb(tokens.colors["code-keyword"]));
  expect(await colour(code.locator(".dw-code-comment"))).toBe(rgb(tokens.colors["code-comment"]));
  expect(await code.evaluate((el) => el.textContent)).toBe(`${SOURCE}\n`);

  await page.locator(".reveal").focus();
  await page.keyboard.press("ArrowRight");
  await expect(present(page)).toHaveAttribute("data-docwalk-id", "patch");
  const added = present(page).locator(".dw-code-inserted");
  await expect(added).toContainText("+const retries = 3;");
  expect(await colour(added, "background-color")).toBe(rgb(tokens.colors["code-inserted-surface"]));
});

test("document mode in the dark theme uses the dark code colours", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openDoc(page);
  await page.getByRole("radio", { name: "Document" }).click();
  const keyword = page.locator(".docwalk-document pre .dw-code-keyword").first();
  await expect(keyword).toHaveText("const");
  expect(await colour(keyword)).toBe(rgb(tokens.colors["code-keyword-dark"]));
});

test("the HTML export carries the colours in its own stylesheet", async ({ page, context }) => {
  await openDoc(page);
  await expect(page.locator(".reveal .slides .dw-code-keyword").first()).toBeAttached();
  const trigger = page.getByRole("button", { name: "Export" });
  await expect(trigger).toBeEnabled();
  const download = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download HTML" }).click();
  const html = await readFile(await (await download).path(), "utf8");
  expect(html).not.toMatch(/<script/i);
  // Opened with nothing from docwalk around it: the colours must come from the file.
  const file = await context.newPage();
  await file.setContent(html);
  const keyword = file.locator(".docwalk-export-page pre .dw-code-keyword").first();
  await expect(keyword).toHaveText("const");
  expect(await colour(keyword)).toBe(rgb(tokens.colors["code-keyword"]));
});
