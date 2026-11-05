import { expect, test } from "@playwright/test";
import { CORS, docTitle, outline, ready, REMOTE_DOC, replaceSource, SHORT_DOC } from "./helpers";

/**
 * Sharing and drafts (decision 7). A pasted document exists only in this
 * browser, so the link and the autosave are the only ways it survives; both
 * depend on App feeding the current text and source to the share module.
 */

test("a #doc= link round-trips: copy it, open it in a new page, get the same slides", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await expect(docTitle(page)).toHaveText("Round trip");
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);

  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this document" });
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Link copied.");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  // An edited document shares its text, not the sample it started from.
  expect(link).toMatch(/^http:\/\/localhost:4174\/#doc=[\w-]+$/);

  const other = await context.newPage();
  await ready(other, link);
  await expect(docTitle(other)).toHaveText("Round trip");
  await expect(other.locator(".docwalk-doc-title")).toContainText("Opened from a shared link");
  expect(await outline(other)).toEqual(await outline(page));
});

test("a pasted document survives a reload as a draft, but never replaces a linked document", async ({
  page,
}) => {
  await ready(page);
  await replaceSource(page, "# Draft that survives\n\n## Kept\n\nStill here.\n");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("docwalk.draft")))
    .toContain("Draft that survives");

  await ready(page, "/");
  await expect(docTitle(page)).toHaveText("Draft that survives");
  await expect(page.locator(".docwalk-doc-title")).toContainText("Pasted · saved in this browser");

  // Someone opening a shared ?src= link expects that document, not their own old draft.
  const raw = "https://raw.githubusercontent.com/acme/docs/main/design.md";
  await page.route(raw, (route) =>
    route.fulfill({ contentType: "text/plain", headers: CORS, body: REMOTE_DOC }),
  );
  await ready(page, `/?src=${encodeURIComponent(raw)}`);
  await expect(docTitle(page)).toHaveText("Remote design doc");
  // ...and loading it did not overwrite the draft either.
  expect(await page.evaluate(() => localStorage.getItem("docwalk.draft"))).toContain(
    "Draft that survives",
  );
});
