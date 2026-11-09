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

test("a commented heading on the scaled slide gets a marker at its text that opens the panel", async ({
  page,
}) => {
  // Decision 94: reveal.js scales the slide to its pane; the marker beside the heading
  // must stay big enough to hit, at the end of the heading's text.
  await openWithDoc(page);
  await addComment(page, "Goals", "Marker on the slide");
  await panel(page).getByRole("button", { name: "Close comments" }).click();
  await page.locator(".docwalk-outline-item", { hasText: "Goals" }).click();

  const stage = page.locator(".docwalk-deck-pane .reveal .slides");
  const marker = page.locator(".docwalk-deck-pane").getByRole("button", {
    name: "1 comment on “Goals”",
  });
  const heading = stage.locator("section.present [id='user-content-goals']");
  const scale = () =>
    stage.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
  /** The marker's distance from the end of the heading's text, and from its middle line. */
  const offset = async () => {
    const box = (await marker.boundingBox())!;
    const line = await heading.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = [...range.getClientRects()].at(-1)!;
      return { right: r.right, middle: r.top + r.height / 2 };
    });
    return { x: box.x - line.right, y: Math.abs(box.y + box.height / 2 - line.middle) };
  };

  await expect(marker).toBeVisible();
  const before = await scale();
  expect(before).toBeLessThan(1);
  const box = (await marker.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(23.99);
  expect(box.height).toBeGreaterThanOrEqual(23.99);
  const at = await offset();
  expect(at.x).toBeGreaterThan(0);
  expect(at.x).toBeLessThanOrEqual(8 * before + 1);
  expect(at.y).toBeLessThan(1);
  // The marker sits beside the pages, so no page (and no export or overview copy of one) holds it.
  await expect(stage.locator("section .docwalk-slide-marker")).toHaveCount(0);
  // The slide chip stays: it is the keyboard path to the panel.
  await expect(page.getByRole("button", { name: /1 comment on this section/ })).toBeVisible();

  // Opening the panel narrows the deck pane, so reveal.js scales the slide again.
  await marker.click();
  await expect(panel(page).getByRole("button", { name: /About$/ })).toContainText("Goals");
  await expect.poll(scale).not.toBe(before);
  await expect
    .poll(async () => {
      const now = await offset();
      return now.x > 0 && now.x <= 8 * (await scale()) + 1 && now.y < 1;
    })
    .toBe(true);
  const after = (await marker.boundingBox())!;
  expect(after.height).toBeGreaterThanOrEqual(23.99);
});

test("a display name goes on new comments, stays in this browser and travels in the link", async ({
  page,
  browser,
}) => {
  // Decision 97. "Reviewer A" is a role label, not a person (AGENTS.md rule 10).
  await openWithDoc(page);
  const name = panel(page).getByRole("textbox", { name: "Your name" });
  await expect(name).toHaveValue("");
  await name.fill("Reviewer A");
  await addComment(page, "Goals", "Signed note");
  const signed = panel(page).locator(".docwalk-comments-item", { hasText: "Signed note" });
  await expect(signed.locator(".docwalk-comments-author")).toHaveText("Reviewer A");

  // Kept in this browser's localStorage, so a reload fills the field again.
  await ready(page, "/");
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(name).toHaveValue("Reviewer A");

  // Clearing the field stops naming new comments; the earlier one keeps its name.
  await name.fill("");
  await addComment(page, "Risks", "Unsigned note");
  const unsigned = panel(page).locator(".docwalk-comments-item", { hasText: "Unsigned note" });
  await expect(unsigned.locator(".docwalk-comments-author")).toHaveCount(0);
  await expect(signed.locator(".docwalk-comments-author")).toHaveText("Reviewer A");

  // The share dialog says the name travels in the clear; the recipient sees it.
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this document" });
  await expect(dialog).toContainText(
    "Comments written under a name carry that name in the link, in the clear.",
  );
  const link = await dialog.getByRole("textbox", { name: "Link" }).inputValue();
  const recipient = await browser.newContext();
  const other = await recipient.newPage();
  await ready(other, link);
  await other.getByRole("button", { name: "Show comments" }).click();
  const received = panel(other).locator(".docwalk-comments-item", { hasText: "Signed note" });
  await expect(received.locator(".docwalk-comments-author")).toHaveText("Reviewer A");
  // The sender's name is not the recipient's: their own field starts empty.
  await expect(panel(other).getByRole("textbox", { name: "Your name" })).toHaveValue("");
  await recipient.close();
});

test("a deleted comment stays deleted when an older sidecar is imported", async ({ page }) => {
  // Decision 95: the deletion leaves a tombstone that beats the older copy in the file.
  await openWithDoc(page);
  await addComment(page, "Goals", "Soon deleted");
  await addComment(page, "Risks", "Kept");
  const exportFile = async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      panel(page)
        .getByRole("button", { name: /^Export comments as/ })
        .click(),
    ]);
    return readFile((await download.path())!, "utf8");
  };
  const older = await exportFile();
  const importFile = async (body: string) => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      panel(page).getByRole("button", { name: "Import comments file" }).click(),
    ]);
    await chooser.setFiles({
      name: "ledger-plan.comments.json",
      mimeType: "application/json",
      buffer: Buffer.from(body),
    });
  };

  const item = panel(page).locator(".docwalk-comments-item", { hasText: "Soon deleted" });
  await item.getByRole("button", { name: "Delete comment" }).click();
  await panel(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(panel(page).getByText("Soon deleted")).toHaveCount(0);

  await importFile(older);
  await expect(panel(page).getByRole("status")).toHaveText(
    "Nothing new: every comment in the file is already here.",
  );
  await expect(panel(page).getByText("Soon deleted")).toHaveCount(0);
  await expect(panel(page).getByText("Kept")).toBeVisible();

  // The next export carries the deletion as an id and a time, never the deleted text.
  const deletedId = (
    JSON.parse(older) as { comments: { id: string; text: string }[] }
  ).comments.find((c) => c.text === "Soon deleted")!.id;
  const newer = await exportFile();
  expect(newer).not.toContain("Soon deleted");
  expect(JSON.parse(newer)).toMatchObject({ deleted: [{ id: deletedId }] });

  // The tombstone is stored: after a reload the older file still cannot bring the comment back.
  await ready(page, "/");
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(panel(page).getByText("Kept")).toBeVisible();
  await importFile(older);
  await expect(panel(page).getByRole("status")).toHaveText(
    "Nothing new: every comment in the file is already here.",
  );
  await expect(panel(page).getByText("Soon deleted")).toHaveCount(0);
});

test("a sidecar that deletes comments here keeps them until the user deletes them", async ({
  page,
}) => {
  // Decision 119: a file names any ids it likes, so it deletes nothing here without asking.
  await openWithDoc(page);
  await addComment(page, "Goals", "Mine to keep");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel(page)
      .getByRole("button", { name: /^Export comments as/ })
      .click(),
  ]);
  const exported = JSON.parse(await readFile((await download.path())!, "utf8")) as {
    comments: { id: string; updated: number }[];
  };
  const mine = exported.comments[0]!;
  const hostile = JSON.stringify({
    ...exported,
    comments: [],
    deleted: [{ id: mine.id, deleted: mine.updated + 1000 }],
  });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    panel(page).getByRole("button", { name: "Import comments file" }).click(),
  ]);
  await chooser.setFiles({
    name: "from-someone.comments.json",
    mimeType: "application/json",
    buffer: Buffer.from(hostile),
  });
  await expect(panel(page).getByRole("status")).toHaveText(
    "It also deletes 1 of your comments here; it stays unless you delete it.",
  );
  await expect(panel(page).getByText("Mine to keep")).toBeVisible();

  await panel(page).getByRole("button", { name: "Delete 1 comment" }).click();
  await expect(panel(page).getByRole("status")).toHaveText("Deleted 1 comment.");
  await expect(panel(page).getByText("Mine to keep")).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Delete 1 comment" })).toHaveCount(0);
});

// Two diagrams for one heading that both have a node `a`.
const CLIENT = ["```mermaid", "flowchart LR", "  a[Client] --> b[Gateway]", "```"].join("\n");
const QUEUE = ["```mermaid", "flowchart LR", "  a[Queue] --> c[Worker]", "```"].join("\n");
const underArchitecture = (...diagrams: string[]) =>
  ["# Swap check", "", "## Architecture", "", diagrams.join("\n\n"), ""].join("\n");

test("swapping two diagrams under one heading keeps each node comment on its own diagram", async ({
  page,
}) => {
  // Decision 96: a position-only match would move the comment on the queue's `a`
  // to the client's `a` without a word.
  await ready(page);
  await replaceSource(page, underArchitecture(CLIENT, QUEUE));
  await expect(page.locator(".docwalk-deck-pane svg g.node")).toHaveCount(4);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await addComment(page, /Queue \(a\)/, "Is the queue durable?");
  await addComment(page, /Gateway \(b\)/, "Who runs the gateway?");
  const glowing = page.locator(".docwalk-deck-pane g[data-docwalk-comments]");
  await expect(glowing).toHaveCount(2);

  await replaceSource(page, underArchitecture(QUEUE, CLIENT));
  // Wait for the rebuilt deck: the first diagram on the stage is now the queue.
  await expect(page.locator(".docwalk-deck-pane svg g.node").first()).toContainText("Queue");
  await expect(panel(page).getByRole("heading", { name: /^Orphaned/ })).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", { name: "Diagram node Queue (a): show on the slide" }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Diagram node Gateway (b): show on the slide" }),
  ).toBeVisible();
  await expect(glowing).toHaveCount(2);
  await expect(glowing.filter({ hasText: "Queue" })).toHaveCount(1);
  await expect(glowing.filter({ hasText: "Gateway" })).toHaveCount(1);
  await expect(glowing.filter({ hasText: "Client" })).toHaveCount(0);
});
