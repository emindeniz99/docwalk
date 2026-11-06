import { expect, test, type BrowserContext, type WebSocketRoute } from "@playwright/test";
import { ready, replaceSource, SHORT_DOC } from "./helpers";

/**
 * Remote control and followers (decision 8) across real pages. The Worker's
 * relay is played by page.routeWebSocket: like worker/room.ts it forwards
 * each frame, unread, to every other socket in the room. Frames are
 * end-to-end encrypted, so this proves the pages agree on keys, message
 * shapes and the follow-up loading of the presenter's document.
 */

/** Offer "remote" from /api/health and relay room frames between every page of the context. */
async function fakeWorker(context: BrowserContext) {
  await context.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, features: ["remote"] } }),
  );
  const sockets = new Set<WebSocketRoute>();
  /** The `?seat=` each socket opened with, in order; null when it sent none. */
  const seats: (string | null)[] = [];
  // Control-key holders add `?seat=` (decision 71), so the room id is not the end of the URL.
  await context.routeWebSocket(/\/api\/remote\/[\w-]{22,64}(\?.*)?$/, (ws) => {
    seats.push(new URL(ws.url()).searchParams.get("seat"));
    sockets.add(ws);
    ws.onMessage((frame) => {
      for (const other of sockets) if (other !== ws) other.send(frame);
    });
    ws.onClose(() => sockets.delete(ws));
  });
  return seats;
}

test("a phone remote moves the presenter's deck and points its laser; a follower follows", async ({
  context,
}) => {
  const seats = await fakeWorker(context);
  const presenter = await context.newPage();
  await ready(presenter);
  // A short pasted document: its #doc= link fits the relay's frame for followers.
  await replaceSource(presenter, SHORT_DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(3);

  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const remoteUrl = await dialog.getByRole("textbox", { name: "Phone remote link" }).inputValue();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  expect(remoteUrl).toMatch(/\?view=remote#room=[\w-]+&k=[\w-]+$/);
  await dialog.getByRole("button", { name: "Close" }).click();

  // The preview follows the editor's cursor, and replaceSource leaves the
  // cursor at the end of the document (slide 3). Start the remote from the
  // first slide the way a presenter would: through the outline.
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

test("without a Worker, remote control is not offered at all", async ({ page }) => {
  // Static hosting (AGENTS.md rule 6): /api/health is missing, so the feature must not appear.
  await ready(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "GitHub token…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Remote/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Sign in/ })).toHaveCount(0);
});
