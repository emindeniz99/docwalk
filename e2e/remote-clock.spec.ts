import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fakeWorker, ready, replaceSource } from "./helpers";

/**
 * The countdown on the phone remote (decision 112), across real pages: the
 * audience tab, a presenter popup that owns the countdown (decision 80), a
 * phone remote and a follower. The relay is played by `routeWebSocket`, so
 * this proves the pages agree: the popup tells the audience tab over the
 * bridge, the tab seals it under the control key, and the phone shows it.
 * The countdown is read in real time, so every clock is read with slack.
 */

const DOC = [
  "# Clock talk",
  "",
  "Cover.",
  ...["One", "Two", "Three", "Four"].flatMap((t) => ["", `## ${t}`, "", `Text ${t}.`]),
  "",
].join("\n");

async function openPresenter(page: Page, context: BrowserContext): Promise<Page> {
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  return presenter;
}

/** "9:05" is 545; "−0:05" is -5. */
async function seconds(clock: Locator): Promise<number> {
  const text = ((await clock.textContent()) ?? "").trim();
  const parts = text.replace("−", "").split(":").map(Number);
  const total = parts.reduce((sum, part) => sum * 60 + part, 0);
  return text.startsWith("−") ? -total : total;
}

test("the phone shows the presenter window's countdown, pausing and closing included; a follower never does", async ({
  context,
}) => {
  test.setTimeout(150_000);
  await fakeWorker(context);
  const audience = await context.newPage();
  await ready(audience);
  await replaceSource(audience, DOC);
  await expect(audience.getByRole("option", { name: /Four/ })).toBeVisible({ timeout: 30_000 });

  await audience.getByRole("button", { name: "More actions" }).click();
  await audience.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = audience.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const remoteUrl = await dialog.getByRole("textbox", { name: "Phone remote link" }).inputValue();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();

  await audience.getByRole("option", { name: /One/ }).click();
  const presenter = await openPresenter(audience, context);
  await expect(presenter.locator(".docwalk-presenter-current .docwalk-presenter-title")).toHaveText(
    "One",
    { timeout: 30_000 },
  );

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(remoteUrl);
  await expect(phone.getByRole("status").getByText("Connected")).toBeVisible();
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText("One");
  const clock = phone.locator(".docwalk-remote-clock");
  const timer = phone.getByRole("timer");
  // Nothing is counting down yet, so the phone shows no clock.
  await expect(timer).toHaveCount(0);

  // A 10-minute target in the presenter window reaches the phone, read-only.
  await presenter.getByLabel("Target (minutes)").fill("10");
  await presenter.getByRole("button", { name: "Start", exact: true }).click();
  await expect(timer).toBeVisible({ timeout: 8000 });
  await expect.poll(() => seconds(timer)).toBeGreaterThan(540);
  await expect.poll(() => seconds(timer)).toBeLessThanOrEqual(600);
  await expect(clock).toContainText("Time left");
  await expect(clock).toContainText(/Ahead of schedule|On pace|Behind schedule/);
  await expect(clock).not.toContainText("Paused");
  await expect(clock.getByRole("button")).toHaveCount(0);

  // It counts on by itself, by the phone's own clock.
  const before = await seconds(timer);
  await expect.poll(() => seconds(timer), { timeout: 8000 }).toBeLessThanOrEqual(before - 2);

  // Pause in the window shows "Paused" on the phone, and the face stands still.
  await presenter.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(clock).toContainText("Paused", { timeout: 3000 });
  const held = await timer.textContent();
  await phone.waitForTimeout(2500);
  await expect(timer).toHaveText(held ?? "");

  // Resume takes "Paused" away again.
  await presenter.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(clock).not.toContainText("Paused", { timeout: 3000 });

  // A follower on the same room gets the slides and none of the clock.
  const follower = await context.newPage();
  await ready(follower, followUrl);
  await expect(follower.locator(".docwalk-doc-title > strong")).toHaveText("Clock talk", {
    timeout: 30_000,
  });
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("2 / 5");
  await follower.waitForTimeout(2500);
  await expect(follower.getByRole("timer")).toHaveCount(0);
  await expect(follower.locator(".docwalk-remote-clock")).toHaveCount(0);

  // Closing the presenter window ends the countdown, and the phone's clock with it.
  await presenter.close();
  await expect(timer).toHaveCount(0, { timeout: 8000 });
  // The phone still steers the deck.
  await expect(phone.getByRole("button", { name: "Next" })).toBeEnabled();
});
