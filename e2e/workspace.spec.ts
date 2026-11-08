import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { docTitle, opfsTest as test, outline, ready, replaceSource } from "./helpers";

/**
 * The workspace (decisions 57, 58) in the assembled app: files kept in the
 * origin private file system, and a local folder through the File System
 * Access API. Playwright drives OPFS for real; `showDirectoryPicker` is
 * stubbed with an OPFS directory handle, which is the same
 * `FileSystemDirectoryHandle` interface a picked folder has, so the folder
 * code paths (explicit save, reload on change, conflicts, permission) run
 * unchanged. "The disk" below is that OPFS directory, written from the test
 * the way an agent or an editor would write the real file.
 */

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
}

const SAMPLE_TITLE = "Ledgerline: payment ledger redesign";
const FOLDER = "picked-folder";

const filesTrigger = (page: Page) => page.locator(".docwalk-files-trigger");
const tree = (page: Page) => page.getByRole("treegrid");
const row = (page: Page, name: string) => tree(page).getByRole("row", { name, exact: true });
const banner = (page: Page) => page.locator(".docwalk-ws-banner");

async function workspaceMenu(page: Page, item: string) {
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function rowMenu(page: Page, name: string, item: string) {
  await row(page, name).hover();
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function newProject(page: Page, name: string, template: string) {
  await workspaceMenu(page, "New project…");
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project name").fill(name);
  // The radio input is visually hidden inside its card; press the card, as a user does.
  await dialog.locator(".docwalk-ws-template", { hasText: template }).first().click();
  await expect(dialog.getByRole("radio", { name: new RegExp(`^${template}`) })).toBeChecked();
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toBeHidden();
}

/** Reads a file of the browser workspace straight from OPFS, not through the app. */
async function readOpfs(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    try {
      let dir = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("docwalk-workspace");
      const parts = p.split("/");
      const name = parts.pop()!;
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, path);
}

/** Writes "the disk": the OPFS directory the stubbed picker hands out. */
async function writeDisk(page: Page, path: string, text: string) {
  await page.evaluate(
    async ([folder, p, t]) => {
      const dir = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle(folder!, {
        create: true,
      });
      const stream = await (await dir.getFileHandle(p!, { create: true })).createWritable();
      await stream.write(t!);
      await stream.close();
    },
    [FOLDER, path, text],
  );
}

async function readDisk(page: Page, path: string): Promise<string> {
  return page.evaluate(
    async ([folder, p]) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder!);
      return (await (await dir.getFileHandle(p!)).getFile()).text();
    },
    [FOLDER, path],
  );
}

/**
 * Replaces `showDirectoryPicker` with one that returns an OPFS directory, and
 * models the permission a real folder handle has: granted after picking,
 * `prompt` again on every page load until "Reconnect" asks for it.
 *
 * Chromium 1243 (the Playwright build here) aborts with SIGTRAP when an OPFS
 * directory handle is read back from IndexedDB in a new document. The app
 * only ever stores handles the real picker returned, so the stub swaps the
 * OPFS handle for a marker on the way into IndexedDB and back on the way out.
 */
async function stubFolderPicker(page: Page, { observer }: { observer: boolean }) {
  await page.addInitScript(
    ([folder, keepObserver]) => {
      const w = globalThis as unknown as Record<string, unknown>;
      const MARKER = "docwalk-test:picked-folder";
      let picked: FileSystemDirectoryHandle | null = null;
      void navigator.storage
        .getDirectory()
        .then((top) => top.getDirectoryHandle(folder as string, { create: true }))
        .then((h) => (picked = h));
      let permission: PermissionState = "prompt";
      w["showDirectoryPicker"] = async () => {
        permission = "granted";
        const top = await navigator.storage.getDirectory();
        return top.getDirectoryHandle(folder as string, { create: true });
      };
      const proto = FileSystemHandle.prototype as unknown as Record<string, unknown>;
      proto["queryPermission"] = async () => permission;
      proto["requestPermission"] = async () => (permission = "granted");
      if (!keepObserver) delete w["FileSystemObserver"];

      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        return put.call(this, value instanceof FileSystemDirectoryHandle ? MARKER : value, key);
      };
      const result = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result")!;
      Object.defineProperty(IDBRequest.prototype, "result", {
        get(this: IDBRequest) {
          const value: unknown = result.get!.call(this);
          return value === MARKER ? picked : value;
        },
      });
    },
    [FOLDER, observer] as const,
  );
}

test("with an empty workspace the sidebar starts with a collapsed Files row and the sample loads as before", async ({
  page,
}) => {
  // Decision 57: an empty workspace must not change the single-document app.
  await ready(page);
  await expect(docTitle(page)).toHaveText(SAMPLE_TITLE);
  await expect(filesTrigger(page)).toHaveAttribute("aria-expanded", "false");
  await expect(tree(page)).toHaveCount(0);
  await expect(page.locator(".docwalk-outline-item").first()).toBeVisible();
});

test("where the browser refuses OPFS, there is no file panel and the sample loads as before", async ({
  page,
}) => {
  // Safari's private windows have the OPFS API but reject getDirectory();
  // a panel whose every action fails would be worse than none (decision 66).
  await page.addInitScript(() => {
    // On the prototype: WebKit ignores an own property set this early.
    Object.defineProperty(StorageManager.prototype, "getDirectory", {
      configurable: true,
      value: () => Promise.reject(new DOMException("The operation failed", "UnknownError")),
    });
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  await ready(page);
  await expect(docTitle(page)).toHaveText(SAMPLE_TITLE);
  await expect(page.locator(".docwalk-outline-item").first()).toBeVisible();
  await expect(filesTrigger(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Workspace actions" })).toHaveCount(0);
});

test("a project made from a template lives in OPFS, autosaves edits, and reopens after a reload", async ({
  page,
}) => {
  await ready(page);
  await newProject(page, "Quarterly review", "Talk");
  await expect(docTitle(page)).toHaveText("Quarterly review");
  await expect(row(page, "talk.md")).toHaveAttribute("aria-selected", "true");
  await expect(banner(page)).toContainText("Quarterly review/talk.md");
  await expect(banner(page)).toContainText("Saved in this browser");
  expect(await readOpfs(page, "Quarterly review/talk.md")).toContain("## Agenda");

  await replaceSource(page, "# Quarterly review\n\n## Edited in docwalk\n\nAutosaved.\n");
  await expect
    .poll(() => readOpfs(page, "Quarterly review/talk.md"))
    .toContain("Edited in docwalk");
  await expect(banner(page)).toContainText("Saved in this browser");

  // The workspace file comes back on a plain visit, edits included, instead of the sample.
  await ready(page);
  await expect(docTitle(page)).toHaveText("Quarterly review");
  expect(await outline(page)).toContainEqual(expect.stringContaining("Edited in docwalk"));
  await expect(row(page, "talk.md")).toHaveAttribute("aria-selected", "true");
});

test("a link still wins over the reopened workspace file", async ({ page }) => {
  // Start-up order is load-bearing (useDocument): links first, then the workspace file, then the draft.
  await ready(page);
  await newProject(page, "Kept", "Blank");
  await expect(docTitle(page)).toHaveText("Kept");
  await page.route("https://raw.githubusercontent.com/**", (route) =>
    route.fulfill({
      body: "# From a link\n\n## One\n\nA.\n",
      headers: { "content-type": "text/plain", "Access-Control-Allow-Origin": "*" },
    }),
  );
  await ready(
    page,
    `/?src=${encodeURIComponent("https://raw.githubusercontent.com/a/b/main/c.md")}`,
  );
  await expect(docTitle(page)).toHaveText("From a link");
});

test("new file, new folder, rename and delete with a confirmation", async ({ page }) => {
  await ready(page);
  await filesTrigger(page).click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("dialog", { name: "New folder" }).getByLabel("Folder name").fill("notes");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(row(page, "notes")).toBeVisible();

  await rowMenu(page, "notes", "New file here…");
  const fileDialog = page.getByRole("dialog", { name: "New file" });
  await expect(fileDialog).toContainText("In notes/");
  await fileDialog.getByLabel("File name").fill("plan");
  await page.getByRole("button", { name: "Create file" }).click();
  // No extension given: it becomes Markdown, and it opens.
  await expect(row(page, "plan.md")).toHaveAttribute("aria-selected", "true");
  await expect(banner(page)).toContainText("notes/plan.md");

  // A name with a separator is refused in the dialog, not by a platform exception.
  await rowMenu(page, "plan.md", "Rename…");
  const renameDialog = page.getByRole("dialog", { name: "Rename plan.md" });
  await renameDialog.getByLabel("New name").fill("../escape");
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  await expect(renameDialog).toContainText("cannot contain");
  await renameDialog.getByLabel("New name").fill("roadmap");
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  // The open file follows its new name.
  await expect(row(page, "roadmap.md")).toHaveAttribute("aria-selected", "true");
  await expect(banner(page)).toContainText("notes/roadmap.md");
  expect(await readOpfs(page, "notes/plan.md")).toBeNull();
  expect(await readOpfs(page, "notes/roadmap.md")).toContain("# plan");

  // Delete asks first; Cancel keeps everything.
  await rowMenu(page, "notes", "Delete…");
  const confirm = page.getByRole("alertdialog", { name: "Delete notes?" });
  await expect(confirm).toContainText("everything in it");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, "notes")).toBeVisible();

  await rowMenu(page, "notes", "Delete…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "notes")).toHaveCount(0);
  expect(await readOpfs(page, "notes/roadmap.md")).toBeNull();
  // The open file went with its folder: the app shows the sample, as a plain visit would.
  await expect(docTitle(page)).toHaveText(SAMPLE_TITLE);
});

test("export as zip, then import a zip with unsafe and unsupported entries", async ({ page }) => {
  await ready(page);
  await newProject(page, "Payments", "Design doc");
  await expect(docTitle(page)).toHaveText("Payments");

  const download = page.waitForEvent("download");
  await workspaceMenu(page, "Export as zip");
  const file = await download;
  expect(file.suggestedFilename()).toBe("docwalk-workspace.zip");
  const exported = unzipSync(new Uint8Array(readFileSync(await file.path())));
  expect(Object.keys(exported).toSorted()).toEqual(["Payments/", "Payments/README.md"]);
  expect(strFromU8(exported["Payments/README.md"]!)).toContain("## Alternatives considered");

  // A hostile archive: a path that climbs out of the workspace, an image, and one real document.
  const archive = zipSync({
    "../escape.md": strToU8("# Escaped\n"),
    "handbook/diagram.png": new Uint8Array([137, 80, 78, 71]),
    "handbook/README.md": strToU8("# Handbook\n\n## Imported slide\n\nFrom a zip.\n"),
  });
  const chooser = page.waitForEvent("filechooser");
  await workspaceMenu(page, "Import zip…");
  await (
    await chooser
  ).setFiles({ name: "handbook.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
  await expect(page.locator(".docwalk-notice")).toContainText(
    "Imported 1 file into handbook. Left out 2 entries",
  );
  await expect(docTitle(page)).toHaveText("Handbook");
  await expect(banner(page)).toContainText("handbook/README.md");
  await expect(tree(page).getByRole("row", { selected: true })).toHaveAccessibleName("README.md");
  expect(await readOpfs(page, "handbook/README.md")).toContain("Imported slide");
  expect(await readOpfs(page, "escape.md")).toBeNull();
  expect(await readOpfs(page, "handbook/diagram.png")).toBeNull();

  // Importing the same archive again never overwrites: it lands in a new folder.
  const again = page.waitForEvent("filechooser");
  await workspaceMenu(page, "Import zip…");
  await (
    await again
  ).setFiles({ name: "handbook.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
  await expect(row(page, "handbook 2")).toBeVisible();
});

test("a second tab follows the first, and a file deleted there is not brought back by autosave", async ({
  page,
  context,
}) => {
  // Decision 90: OPFS edits in another tab used to be unseen, and the last write won.
  await ready(page);
  await newProject(page, "Shared", "Blank");
  await expect(docTitle(page)).toHaveText("Shared");
  const other = await context.newPage();
  await ready(other);
  await expect(docTitle(other)).toHaveText("Shared");
  await expect(row(other, "README.md")).toHaveAttribute("aria-selected", "true");

  // An edit in the second tab reaches the first, which had none of its own.
  await replaceSource(other, "# Shared\n\nFrom the second tab.\n");
  await expect(page.locator(".cm-content")).toContainText("From the second tab");

  // The first deletes the file. The second keeps its text, says so, and does not write the file again.
  await rowMenu(page, "README.md", "Delete…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(banner(other)).toContainText("Deleted or moved in another tab");
  await replaceSource(other, "# Shared\n\nTyped after the delete.\n");
  await other.waitForTimeout(1500);
  expect(await readOpfs(page, "Shared/README.md")).toBeNull();

  // Save is the user's answer: it writes the file back.
  await banner(other).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => readOpfs(page, "Shared/README.md")).toContain("Typed after the delete");
  await expect(banner(other)).toContainText("Saved in this browser");
});

test("a local folder saves only on request and reloads when the file changes on disk (polling)", async ({
  page,
}) => {
  await stubFolderPicker(page, { observer: false });
  await ready(page);
  await writeDisk(page, "deck.md", "# Disk deck\n\n## First\n\nOne.\n");
  await workspaceMenu(page, "Open local folder…");
  await expect(filesTrigger(page)).toContainText(FOLDER);
  await row(page, "deck.md").click();
  await expect(docTitle(page)).toHaveText("Disk deck");
  await expect(banner(page)).toContainText("Saved to disk");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  // An agent edits the file: with no unsaved edits the deck follows the disk.
  await writeDisk(page, "deck.md", "# Disk deck\n\n## Changed by an agent\n\nTwo.\n");
  await expect
    .poll(() => outline(page), { timeout: 10_000 })
    .toContainEqual(expect.stringContaining("Changed by an agent"));

  // Edits stay in the browser until saved.
  await replaceSource(page, "# Disk deck\n\n## Typed here\n\nThree.\n");
  await expect(banner(page)).toContainText("Unsaved changes");
  await expect(page.getByRole("img", { name: "Unsaved changes" })).toBeVisible();
  expect(await readDisk(page, "deck.md")).toContain("Changed by an agent");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(banner(page)).toContainText("Saved to disk");
  expect(await readDisk(page, "deck.md")).toContain("Typed here");

  // The disk changes over unsaved edits: the user picks which to keep.
  await replaceSource(page, "# Disk deck\n\n## Mine, unsaved\n\nFour.\n");
  await writeDisk(page, "deck.md", "# Disk deck\n\n## Theirs on disk\n\nFive.\n");
  const conflict = page.getByRole("alertdialog", { name: "deck.md changed on disk" });
  await expect(conflict).toBeVisible({ timeout: 10_000 });
  await expectNoSeriousViolations(page);
  await conflict.getByRole("button", { name: "Keep my edits" }).click();
  await expect(conflict).toBeHidden();
  await expect(banner(page)).toContainText("Unsaved changes");
  expect(await outline(page)).toContainEqual(expect.stringContaining("Mine, unsaved"));
  // Keeping is not asked again for the same disk version.
  await page.waitForTimeout(2500);
  await expect(conflict).toBeHidden();

  await writeDisk(page, "deck.md", "# Disk deck\n\n## Theirs again\n\nSix.\n");
  await expect(conflict).toBeVisible({ timeout: 10_000 });
  await conflict.getByRole("button", { name: "Load the disk version" }).click();
  await expect.poll(() => outline(page)).toContainEqual(expect.stringContaining("Theirs again"));
  await expect(banner(page)).toContainText("Saved to disk");
});

test("with FileSystemObserver the open local file reloads on change", async ({ page }) => {
  await stubFolderPicker(page, { observer: true });
  await ready(page);
  const hasObserver = await page.evaluate(() => "FileSystemObserver" in globalThis);
  test.skip(
    !hasObserver,
    "This Chromium build has no FileSystemObserver; polling is covered above.",
  );
  await writeDisk(page, "deck.md", "# Watched\n\n## Before\n\nOne.\n");
  await workspaceMenu(page, "Open local folder…");
  await row(page, "deck.md").click();
  await expect(docTitle(page)).toHaveText("Watched");
  await writeDisk(page, "deck.md", "# Watched\n\n## After\n\nTwo.\n");
  await expect
    .poll(() => outline(page), { timeout: 10_000 })
    .toContainEqual(expect.stringContaining("After"));
  // A file added on disk shows up in the tree without a reload.
  await writeDisk(page, "added.md", "# Added\n");
  await expect(row(page, "added.md")).toBeVisible({ timeout: 10_000 });
});

test("on return the folder asks for permission again, then reopens its file", async ({ page }) => {
  await stubFolderPicker(page, { observer: false });
  await ready(page);
  await writeDisk(page, "deck.md", "# Come back\n\n## Slide\n\nOne.\n");
  await workspaceMenu(page, "Open local folder…");
  await row(page, "deck.md").click();
  await expect(docTitle(page)).toHaveText("Come back");

  // A new visit: the handle is in IndexedDB, but access must be granted again with a click.
  await ready(page);
  await expect(docTitle(page)).toHaveText(SAMPLE_TITLE);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(docTitle(page)).toHaveText("Come back");
  await expect(row(page, "deck.md")).toHaveAttribute("aria-selected", "true");
});

test("unsaved local edits are not dropped by opening another file", async ({ page }) => {
  await stubFolderPicker(page, { observer: false });
  await ready(page);
  await writeDisk(page, "a.md", "# File A\n\n## A\n\nA.\n");
  await writeDisk(page, "b.md", "# File B\n\n## B\n\nB.\n");
  await workspaceMenu(page, "Open local folder…");
  await row(page, "a.md").click();
  await replaceSource(page, "# File A\n\n## A edited\n\nA.\n");
  await row(page, "b.md").click();
  const ask = page.getByRole("alertdialog", { name: "Save changes to a.md?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(docTitle(page)).toHaveText("File A");
  await row(page, "b.md").click();
  await ask.getByRole("button", { name: "Save" }).click();
  await expect(docTitle(page)).toHaveText("File B");
  expect(await readDisk(page, "a.md")).toContain("A edited");

  // Open file asks too: it would replace the unsaved text just the same.
  await replaceSource(page, "# File B\n\n## B edited\n\nB.\n");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open file" }).click();
  await (
    await chooser
  ).setFiles({
    name: "other.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Other\n\n## Slide\n\nX.\n"),
  });
  const askAgain = page.getByRole("alertdialog", { name: "Save changes to b.md?" });
  await askAgain.getByRole("button", { name: "Discard changes" }).click();
  await expect(docTitle(page)).toHaveText("Other");
  expect(await readDisk(page, "b.md")).not.toContain("B edited");
});

test("the file tree works from the keyboard", async ({ page }) => {
  await ready(page);
  await newProject(page, "Keys", "Blank");
  // "New file" puts the file next to the open one, inside Keys/.
  await page.getByRole("button", { name: "New file" }).click();
  await page.getByLabel("File name").fill("second");
  await page.keyboard.press("Enter");
  await expect(row(page, "second.md")).toHaveAttribute("aria-selected", "true");
  // Focus goes to the row the dialog made (WCAG 2.4.3), a frame after the
  // dialog closes. Opening the file is a separate step and can finish first:
  // a key pressed before the focus lands is undone when it does.
  await expect(row(page, "second.md")).toBeFocused();

  // Arrows move without opening; Enter opens.
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "README.md")).toBeFocused();
  await expect(banner(page)).toContainText("Keys/second.md");
  await page.keyboard.press("Enter");
  await expect(banner(page)).toContainText("Keys/README.md");

  // Left and right collapse and expand a folder.
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Keys")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "Keys")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Keys")).toHaveAttribute("aria-expanded", "true");

  // The row's actions are reachable with the arrow keys too.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Actions for README.md" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Rename…" })).toBeVisible();
});

test("on a 390 px phone a long workspace path does not widen the page, and panel targets are 44 px", async ({
  page,
}) => {
  // The banner's path is nowrap text; it once set the header's minimum width and pushed the page sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await stubFolderPicker(page, { observer: false });
  await ready(page);
  await newProject(page, "A project with a rather long name", "Design doc");
  await expect(banner(page)).toContainText("Saved in this browser");
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  for (const name of ["New file", "New folder", "Workspace actions", "Actions for README.md"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0, name).toBeGreaterThanOrEqual(44);
  }

  // A local file's Save button stays on screen and reachable on a phone.
  await writeDisk(page, "deck.md", "# Phone deck\n\n## One\n\nA.\n");
  await workspaceMenu(page, "Open local folder…");
  await row(page, "deck.md").click();
  await replaceSource(page, "# Phone deck\n\n## Edited\n\nB.\n");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  const box = await save.boundingBox();
  expect((box?.x ?? 999) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await save.click();
  await expect(banner(page)).toContainText("Saved to disk");
});

test("on a 390 px phone an open file tree leaves the outline at least three rows", async ({
  page,
}) => {
  // Files, outline and the level picker share one sidebar on a phone. An
  // expanded tree once took all of it but one outline row, so the outline,
  // the way to jump to a section, was effectively gone.
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await newProject(page, "Phone outline", "Design doc");
  await expect(page.locator(".docwalk-files[data-expanded]")).toHaveCount(1);
  await expect(tree(page).getByRole("row")).not.toHaveCount(0);
  // The project's file opens after the dialog closes; until then the outline
  // still lists the sample document, mid-swap. Measure the new one.
  await expect(page.locator(".docwalk-outline-item").first()).toContainText("Phone outline");
  // Clip each row by every ancestor that hides overflow, then by the window.
  const visibleRows = await page.locator(".docwalk-outline-item").evaluateAll(
    (items) =>
      items.filter((el) => {
        let { top, bottom } = el.getBoundingClientRect();
        const height = bottom - top;
        for (let a = el.parentElement; a; a = a.parentElement) {
          if (getComputedStyle(a).overflowY === "visible") continue;
          const r = a.getBoundingClientRect();
          top = Math.max(top, r.top);
          bottom = Math.min(bottom, r.bottom);
        }
        return Math.min(bottom, innerHeight) - Math.max(top, 0) >= height - 1;
      }).length,
  );
  expect(visibleRows).toBeGreaterThanOrEqual(3);
});

test("axe: the file panel and its dialogs", async ({ page }) => {
  await ready(page);
  await newProject(page, "Accessible", "Design doc");
  await expect(tree(page)).toBeVisible();
  await expectNoSeriousViolations(page);
  await workspaceMenu(page, "New project…");
  await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.keyboard.press("Escape");
  await rowMenu(page, "README.md", "Delete…");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectNoSeriousViolations(page);
});
