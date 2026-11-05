import { readFile } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Comments (decision 55), end to end in the built app: they anchor to
 * headings and diagram nodes, live in this browser, travel in the share
 * link and as a sidecar file, and an anchor that disappears leaves its
 * comment visible as orphaned instead of losing it.
 */

const DOC = [
  "# Ledger plan",
  "",
  "## Goals",
  "",
  "Keep every entry.",
  "",
  "## Architecture",
  "",
  "```mermaid",
  "flowchart LR",
  "  client[Client] --> api_gw[API gateway]",
  "```",
  "",
  "## Risks",
  "",
  "Few.",
  "",
].join("\n");

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Comments" });

async function openWithDoc(page: Page) {
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(4);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(panel(page)).toBeVisible();
}

async function addComment(page: Page, about: RegExp | string, text: string) {
  await panel(page)
    .getByRole("button", { name: /About$/ })
    .click();
  // The outline is a listbox too; pick from the anchor list that just opened.
  await page.locator(".docwalk-comments-popover").getByRole("option", { name: about }).click();
  await panel(page).getByRole("textbox", { name: "New comment" }).fill(text);
  await panel(page).getByRole("button", { name: "Add comment" }).click();
  await expect(panel(page).getByRole("status")).toHaveText("Comment added.");
}

test("add a comment, see it counted, share the link, and the recipient gets it", async ({
  page,
  browser,
}) => {
  await openWithDoc(page);
  // Comment text is plain text: markup in it must stay text, never become HTML.
  await addComment(page, "Goals", "Which quarter?\n<img src=x onerror=alert(1)>");
  await expect(panel(page).getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  await expect(panel(page).locator("img")).toHaveCount(0);

  // The outline counts it on its section, and the slide marker appears there.
  await expect(page.locator(".docwalk-outline-item", { hasText: "Goals" })).toContainText(
    "1 comment",
  );
  await page.locator(".docwalk-outline-item", { hasText: "Goals" }).click();
  await expect(page.getByRole("button", { name: /1 comment on this section/ })).toBeVisible();

  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this document" });
  await expect(dialog.getByRole("checkbox", { name: "Include 1 comment" })).toBeChecked();
  const field = dialog.getByRole("textbox", { name: "Link" });
  await expect(field).toHaveValue(/#doc=[\w-]+&c=[\w-]+$/);
  const link = await field.inputValue();

  // Unticking leaves a link with the document only.
  // Pressed where a pointer user presses it: the label, which holds the drawn box.
  await dialog.getByText("Include 1 comment").click();
  await expect(dialog.getByRole("checkbox", { name: "Include 1 comment" })).not.toBeChecked();
  await expect(field).toHaveValue(/#doc=[\w-]+$/);

  // The recipient is someone else: a fresh profile with no copy of these comments.
  const recipient = await browser.newContext();
  const other = await recipient.newPage();
  await ready(other, link);
  await expect(other.locator(".docwalk-notice")).toContainText("This link carries 1 comment");
  // Imported once: a reload must not resurrect a comment deleted since.
  await expect.poll(() => other.evaluate(() => location.hash)).not.toContain("&c=");
  await other.getByRole("button", { name: "Show comments" }).click();
  await expect(panel(other).getByText("Which quarter?")).toBeVisible();
  await recipient.close();
});

test("a diagram node takes comments; a renamed heading orphans its comments instead of losing them", async ({
  page,
}) => {
  await openWithDoc(page);
  await addComment(page, /API gateway \(api_gw\)/, "Do we need a gateway?");
  await addComment(page, "Risks", "List them.");
  // The node glows on the slide; the panel groups the comment under the node.
  await expect(page.locator(".docwalk-deck-pane g[data-docwalk-comments]")).toHaveCount(1);
  await expect(
    panel(page).getByRole("button", {
      name: "Diagram node API gateway (api_gw): show on the slide",
    }),
  ).toBeVisible();

  await replaceSource(page, DOC.replace("## Risks", "## Open questions"));
  await expect(panel(page).getByRole("heading", { name: "Orphaned (1)" })).toBeVisible();
  await expect(panel(page).getByText("Heading #risks")).toBeVisible();
  await expect(panel(page).getByText("List them.")).toBeVisible();

  // Edited text stays the draft, and its comments come back with it after a reload.
  await ready(page, "/");
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(panel(page).getByText("Do we need a gateway?")).toBeVisible();
  await expect(panel(page).getByText("List them.")).toBeVisible();
});

test("edit, resolve and delete a comment", async ({ page }) => {
  await openWithDoc(page);
  await addComment(page, "Goals", "First take");
  const item = panel(page).locator(".docwalk-comments-item");
  await item.getByRole("button", { name: "Edit comment" }).click();
  await panel(page).getByRole("textbox", { name: "Edit comment" }).fill("Second take");
  await panel(page).getByRole("button", { name: "Save" }).click();
  await expect(item).toContainText("Second take");
  await expect(item).toContainText("edited");

  await item.getByRole("button", { name: "Resolve comment" }).click();
  await expect(panel(page).getByText("No open comments.")).toBeVisible();
  await expect(page.locator(".docwalk-outline-item", { hasText: "Goals" })).not.toContainText(
    "comment",
  );
  await panel(page).getByRole("radio", { name: "Resolved (1)" }).click();
  await panel(page).getByRole("button", { name: "Delete comment" }).click();
  await panel(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(panel(page).getByText("No resolved comments.")).toBeVisible();
  // Focus does not fall to the page when the comment's buttons go away.
  await expect(panel(page).getByRole("heading", { name: "Comments" })).toBeFocused();
});

test("export the sidecar, refuse a hostile one, import a valid one", async ({ page }, info) => {
  await openWithDoc(page);
  await addComment(page, "Goals", "Exported comment");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel(page)
      .getByRole("button", { name: /^Export comments as/ })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe("ledger-plan.comments.json");
  const saved = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(saved).toMatchObject({ format: "docwalk-comments", version: 1 });
  expect(saved.comments).toHaveLength(1);

  const chooser = async (name: string, body: string) => {
    const [fc] = await Promise.all([
      page.waitForEvent("filechooser"),
      panel(page).getByRole("button", { name: "Import comments file" }).click(),
    ]);
    await fc.setFiles({ name, mimeType: "application/json", buffer: Buffer.from(body) });
  };

  await chooser(
    "evil.json",
    JSON.stringify({ format: "docwalk-comments", version: 1, comments: [{ id: "<x>" }] }),
  );
  await expect(panel(page).getByRole("status")).toHaveText(/damaged/);

  const imported = {
    ...saved,
    comments: [{ ...saved.comments[0], id: "from-a-colleague", text: "Imported comment" }],
  };
  await chooser("ledger-plan.comments.json", JSON.stringify(imported));
  await expect(panel(page).getByRole("status")).toHaveText("Imported 1 comment.");
  await expect(panel(page).getByText("Imported comment")).toBeVisible();
  await expect(panel(page).getByText("Exported comment")).toBeVisible();
  void info;
});

test("document mode marks commented headings, and the marker opens the panel", async ({ page }) => {
  await openWithDoc(page);
  await addComment(page, "Risks", "Marker check");
  await panel(page).getByRole("button", { name: "Close comments" }).click();
  await expect(panel(page)).toHaveCount(0);
  // Closing gives focus back to the toggle.
  await expect(page.getByRole("button", { name: /^Comments/ })).toBeFocused();
  await page.getByRole("radio", { name: "Document" }).click();
  await page.getByRole("button", { name: "1 comment on “Risks”" }).click();
  await expect(panel(page).getByRole("button", { name: /About$/ })).toContainText("Risks");
});

test("the comments panel passes axe", async ({ page }) => {
  await openWithDoc(page);
  await addComment(page, /API gateway/, "Axe check");
  await expectNoSeriousViolations(page);
});

test("on a 390 px phone the panel is a sheet that passes axe and closes with Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await replaceSource(page, DOC);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Comments" }).click();
  const sheet = page.getByRole("dialog", { name: "Comments" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("textbox", { name: "New comment" }).fill("From a phone");
  await sheet.getByRole("button", { name: "Add comment" }).click();
  await expect(sheet.getByText("From a phone")).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box?.width ?? Infinity).toBeLessThanOrEqual(390);
  await expectNoSeriousViolations(page);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
