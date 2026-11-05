import { expect, type Page } from "@playwright/test";

/** Opens `path` and waits until the deck has rendered and reported its slides. */
export async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, { timeout: 30_000 });
}

/** Replaces the editor's text the way a paste does (one input event, no key-by-key auto-indent). */
export async function replaceSource(page: Page, markdown: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(markdown);
}

/** The document title the header shows. */
export const docTitle = (page: Page) => page.locator(".docwalk-doc-title > strong");

/** Outline entries, in order: section titles with their page counts. */
export const outline = (page: Page) => page.locator(".docwalk-outline-item").allInnerTexts();

/** A short document with an H1 cover and two slides; nothing personal (AGENTS.md rule 10). */
export const SHORT_DOC = "# Round trip\n\n## First point\n\nAlpha.\n\n## Second point\n\nBeta.\n";

/** What the mocked GitHub hosts serve. */
export const REMOTE_DOC =
  "# Remote design doc\n\n## Loaded slide one\n\nServed by a mock.\n\n## Loaded slide two\n\nAlso mocked.\n";

/** A cross-origin fetch from the app only reads a response that allows it. */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, accept, x-github-api-version",
  "Access-Control-Allow-Methods": "GET",
};
