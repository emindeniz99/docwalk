import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource } from "./helpers";

/**
 * The diagram tour, mirrored (decision 109) across real pages, with the
 * relay played by `fakeRelay` as in mirror-focus.spec.ts. The presenter walks
 * a path through a flowchart; the follower, on a smaller screen, rings the
 * same nodes of its own copy. A path travels as node numbers, so the proof is
 * that both pages ring the node with the same source id.
 */

const SHOTS = process.env["DOCWALK_SHOTS"];

const DOC = [
  "# Tour talk",
  "",
  "## One",
  "",
  "Alpha.",
  "",
  "## Flow",
  "",
  "```mermaid",
  "flowchart LR",
  "  a[Client] --> b[Gateway]",
  "  b --> c[Service]",
  "  c --> d[Database]",
  "```",
  "",
].join("\n");
const SLIDES = 3;

const view = (page: Page) => page.locator(".docwalk-focus[data-kind='diagram']");
const status = (page: Page) => view(page).locator(".docwalk-tour-status");
const rings = (page: Page) => view(page).locator(".docwalk-tour-ring");

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/**
 * The source id of the node the solid ring surrounds, or null: the node whose
 * box lies inside the ring's. Mermaid writes `<render id>-flowchart-<id>-<n>`
 * on a node, and the render id differs between pages, so only the middle compares.
 */
const ringedNode = (page: Page) =>
  view(page).evaluate((root) => {
    const ring = root.querySelector(".docwalk-tour-ring");
    if (!ring) return null;
    const outer = ring.getBoundingClientRect();
    const inside = [...root.querySelectorAll<SVGGElement>("svg g.node")].filter((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.left >= outer.left - 1 &&
        box.right <= outer.right + 1 &&
        box.top >= outer.top - 1 &&
        box.bottom <= outer.bottom + 1
      );
    });
    if (inside.length !== 1) return null;
    return /flowchart-(.+)-\d+$/.exec(inside[0]!.id)?.[1] ?? null;
  });

async function openPresenterRoom(context: BrowserContext) {
  const presenter = await context.newPage();
  await ready(presenter);
  await replaceSource(presenter, DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(SLIDES);
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
  size = { width: 900, height: 600 },
) {
  const follower = await context.newPage();
  await follower.setViewportSize(size);
  await ready(follower, url);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText(
    new RegExp(`/ ${SLIDES}$`),
  );
  return follower;
}

/** Both pages on the Flow slide, with the presenter's diagram view open. */
async function openDiagram(presenter: Page, follower: Page) {
  await presenter.getByRole("option", { name: /Flow/ }).click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText(`3 / ${SLIDES}`);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText(`3 / ${SLIDES}`);
  await presenter.locator(".reveal .slides section.present .docwalk-diagram").click();
  await expect(view(presenter)).toBeVisible();
  await expect(view(follower)).toBeVisible();
  await expect(view(presenter).locator("svg g.node")).toHaveCount(4);
  await expect(view(follower).locator("svg g.node")).toHaveCount(4);
}

test("the follower rings the node the presenter's tour is on, step by step, and drops the rings when it ends", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl, { width: 700, height: 500 });
  await openDiagram(presenter, follower);

  await presenter.keyboard.press("t");
  await expect(status(presenter)).toContainText("Client. Node 1 of 4.");
  await expect(status(follower)).toContainText("Client. Node 1 of 4.");
  await expect.poll(() => ringedNode(follower)).toBe("a");
  // The path is sent at once, and each page draws its first ring after its own animation
  // frames. The presenter's page is behind the follower's here, where Chromium gives it
  // about one frame a second, so the follower's ring can be there first. Later rings are
  // drawn with the status.
  await expect.poll(() => ringedNode(presenter)).toBe("a");

  await presenter.keyboard.press("ArrowRight");
  await presenter.keyboard.press("ArrowRight");
  await expect(status(presenter)).toContainText("Service. Node 3 of 4.");
  await expect(status(follower)).toContainText("Service. Node 3 of 4.");
  await expect.poll(() => ringedNode(follower)).toBe("c");
  expect(await ringedNode(presenter)).toBe("c");
  await expect(follower.locator(".docwalk-focus .docwalk-tour-count")).toHaveText("3 / 4");
  await shot(follower, "follower-tour-step");

  // Back is a change of path too: the follower follows it.
  await presenter.keyboard.press("ArrowLeft");
  await expect.poll(() => ringedNode(follower)).toBe("b");

  // The first Escape ends the presenter's tour and keeps both views; the follower's rings go.
  await presenter.keyboard.press("Escape");
  await expect(rings(presenter)).toHaveCount(0);
  await expect(rings(follower)).toHaveCount(0);
  await expect(view(presenter)).toBeVisible();
  await expect(view(follower)).toBeVisible();
  await expect(follower.getByRole("button", { name: "Tour" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // The second closes the presenter's view, and the follower's with it.
  await presenter.keyboard.press("Escape");
  await expect(view(presenter)).toHaveCount(0);
  await expect(view(follower)).toHaveCount(0);
});

test("a follower that steps on its own keeps its steps until the presenter's path changes", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await openDiagram(presenter, follower);

  await presenter.keyboard.press("t");
  await expect.poll(() => ringedNode(follower)).toBe("a");
  // The presenter's own first ring can come after the follower's (see the test above);
  // it has to be drawn before "still on a" below can be read once.
  await expect.poll(() => ringedNode(presenter)).toBe("a");
  await follower.getByRole("button", { name: "Next node" }).click();
  await follower.getByRole("button", { name: "Next node" }).click();
  await expect.poll(() => ringedNode(follower)).toBe("c");
  expect(await ringedNode(presenter)).toBe("a");

  // The presenter's next step is a change of path: both are on the node it names.
  await presenter.keyboard.press("ArrowRight");
  await expect.poll(() => ringedNode(follower)).toBe("b");
  expect(await ringedNode(presenter)).toBe("b");
});

test("a follower that joins late gets the presenter's current path, and one that missed its end drops it", async ({
  context,
}) => {
  const relay = await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  await presenter.getByRole("option", { name: /Flow/ }).click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText(`3 / ${SLIDES}`);
  await presenter.locator(".reveal .slides section.present .docwalk-diagram").click();
  await expect(view(presenter)).toBeVisible();
  await presenter.keyboard.press("t");
  await presenter.keyboard.press("ArrowRight");
  await presenter.keyboard.press("ArrowRight");
  await expect(status(presenter)).toContainText("Service. Node 3 of 4.");

  // The newcomer's hello brings a resync: the open view, then the path.
  const follower = await openFollower(context, followUrl);
  await expect(view(follower)).toBeVisible();
  await expect.poll(() => ringedNode(follower)).toBe("c");
  await expect(status(follower)).toContainText("Service. Node 3 of 4.");
  await shot(follower, "late-follower-tour");

  // The follower is cut off while the presenter ends the tour; the next resync is empty, and the rings go.
  relay.state.refuseFollowers = true;
  await relay.dropFollowers();
  await presenter.keyboard.press("Escape");
  await expect(rings(presenter)).toHaveCount(0);
  await expect(rings(follower)).toHaveCount(1);
  relay.state.refuseFollowers = false;
  await expect(rings(follower)).toHaveCount(0, { timeout: 20_000 });
  await expect(view(follower)).toBeVisible();
});
