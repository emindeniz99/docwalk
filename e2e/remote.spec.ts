import { expect, test } from "@playwright/test";
import { docLink, fakeWorker, ready, SHORT_DOC } from "./helpers";

/**
 * Remote control and followers (decision 8) across real pages. The Worker's
 * relay is played by page.routeWebSocket: like worker/room.ts it forwards
 * each frame, unread, to every other socket in the room. Frames are
 * end-to-end encrypted, so this proves the pages agree on keys, message
 * shapes and the follow-up loading of the presenter's document.
 */

test("a phone remote moves the presenter's deck and points its laser; a follower follows", async ({
  context,
}) => {
  const seats = await fakeWorker(context);
  const presenter = await context.newPage();
  // A short document: its #doc= link fits the relay's frame for followers.
  await ready(presenter, docLink(SHORT_DOC));
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(3);

  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const remoteUrl = await dialog.getByRole("textbox", { name: "Phone remote link" }).inputValue();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  // The public state key rides along, so the phone can check the signed countdown (decision 117).
  expect(remoteUrl).toMatch(/\?view=remote#room=[\w-]+&k=[\w-]+&p=[\w-]+$/);
  await dialog.getByRole("button", { name: "Close" }).click();

  // Start the remote from the first slide the way a presenter would: through the outline.
  await presenter.locator(".docwalk-outline-item").first().click();
  const counter = presenter.locator(".docwalk-preview-head strong");
  await expect(counter).toHaveText("1 / 3");

  const remote = await context.newPage();
  await remote.setViewportSize({ width: 390, height: 844 });
  await remote.goto(remoteUrl);
  await expect(remote.getByRole("status").getByText("Connected")).toBeVisible();
  await expect(remote.getByRole("heading", { level: 1 })).toHaveText("Round trip");

  await remote.getByRole("button", { name: "Next" }).click();
  await expect(counter).toHaveText("2 / 3");
  await expect(remote.getByRole("heading", { level: 1 })).toHaveText("First point");

  // The laser lands on the presenter's stage, above the slide.
  const pad = remote.locator(".docwalk-remote-pad");
  const box = await pad.boundingBox();
  if (!box) throw new Error("laser pad missing");
  await remote.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await remote.mouse.down();
  await expect(presenter.locator(".docwalk-remote-laser")).toBeVisible();
  await remote.mouse.up();
  await expect(presenter.locator(".docwalk-remote-laser")).toBeHidden();

  // A follower loads the presenter's document from the state's link, then tracks the slide.
  const follower = await context.newPage();
  await ready(follower, followUrl);
  await expect(follower.locator(".docwalk-doc-title > strong")).toHaveText("Round trip");
  const followCounter = follower.locator(".docwalk-preview-head strong");
  await expect(followCounter).toHaveText("2 / 3");
  // Read-only: no editor, no outline, nothing to change the document with.
  await expect(follower.locator(".cm-content")).toHaveCount(0);
  await expect(follower.getByRole("button", { name: "Open file" })).toHaveCount(0);
  await expect(follower.getByRole("button", { name: "Present" })).toHaveCount(0);
  // The room fragment stays: a reload must rejoin, so URL sync may not rewrite it.
  expect(new URL(follower.url()).hash).toMatch(/^#room=/);

  await remote.getByRole("button", { name: "Next" }).click();
  await expect(counter).toHaveText("3 / 3");
  await expect(followCounter).toHaveText("3 / 3");

  // The presenter and the phone prove the control key with the same seat token;
  // the follower holds only the view key, so it must not send one (decision 71).
  const proved = seats.filter((seat) => seat !== null);
  expect(proved.length).toBeGreaterThanOrEqual(2);
  expect(new Set(proved).size).toBe(1);
  expect(seats).toContain(null);
});

test("on the map a phone's Next and Previous walk the frames, ### frames included, and the deck follows at section level", async ({
  context,
}) => {
  // Decision 152. A short document whose second section has a ### part, so
  // one press moves the map and leaves the deck's slide as it was.
  const doc =
    "# Round trip\n\n## First point\n\nAlpha.\n\n### Detail\n\nDeep.\n\n## Second point\n\nBeta.\n";
  await fakeWorker(context);
  const presenter = await context.newPage();
  await ready(presenter, docLink(doc));
  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const remoteUrl = await dialog.getByRole("textbox", { name: "Phone remote link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();

  await presenter.getByRole("radio", { name: "Map" }).click();
  const map = presenter.getByRole("region", { name: "Map", exact: true });
  const frames = map.locator("[data-map-frame]");
  await expect(frames).toHaveCount(4);
  const ids = await frames.evaluateAll((els) => els.map((el) => el.getAttribute("data-map-frame")));
  const current = map.locator('[data-map-frame][aria-current="true"]');
  await expect(current).toHaveAttribute("data-map-frame", ids[0]!);

  const remote = await context.newPage();
  await remote.setViewportSize({ width: 390, height: 844 });
  await remote.goto(remoteUrl);
  await expect(remote.getByRole("status").getByText("Connected")).toBeVisible();
  await expect(remote.getByRole("heading", { level: 1 })).toHaveText("Round trip");

  // Next walks the route frame by frame; the keyboard focus stays where it was (the page body).
  await remote.getByRole("button", { name: "Next" }).click();
  await expect(current).toHaveAttribute("data-map-frame", ids[1]!);
  await expect(remote.getByRole("heading", { level: 1 })).toHaveText("First point");
  await remote.getByRole("button", { name: "Next" }).click();
  await expect(current).toHaveAttribute("data-map-frame", ids[2]!);
  // The ### frame is no deck section: the phone still shows the section's slide.
  await expect(remote.getByRole("heading", { level: 1 })).toHaveText("First point");
  await remote.getByRole("button", { name: "Next" }).click();
  await expect(current).toHaveAttribute("data-map-frame", ids[3]!);
  await expect(remote.getByRole("heading", { level: 1 })).toHaveText("Second point");
  await remote.getByRole("button", { name: "Previous" }).click();
  await expect(current).toHaveAttribute("data-map-frame", ids[2]!);
  await expect(remote.getByRole("heading", { level: 1 })).toHaveText("First point");
});

test("without a Worker, remote control is not offered at all", async ({ page }) => {
  // Static hosting (AGENTS.md rule 6): /api/health is missing, so the feature must not appear.
  await ready(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "GitHub token…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Remote/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Sign in/ })).toHaveCount(0);
});
