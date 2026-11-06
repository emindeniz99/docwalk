import { expect, test } from "@playwright/test";
import { docTitle, ready, replaceSource } from "./helpers";

/**
 * Rule 8 and decision 33 in the built app: presenting a document with images
 * from another host contacts that host only for an image the viewer clicks.
 * reveal.js preloads slides near the current one and Mermaid fetches image
 * shapes while it renders, so this counts real requests while every slide is
 * shown, rather than checking the markup once.
 */

const TRACKER = "tracker.invalid";
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const DOC = [
  "# Tracked deck",
  ...[1, 2, 3, 4].map((n) => `## Image ${n}\n\n![chart ${n}](https://${TRACKER}/slide${n}.png)`),
  "## Diagram\n\n```mermaid\nflowchart LR\n  A@{ img: https://" +
    TRACKER +
    "/shape.png, label: A } --> B\n```",
].join("\n\n");

test("stepping through a deck with remote images requests nothing until one is clicked", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route(`https://${TRACKER}/**`, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ contentType: "image/png", body: PIXEL });
  });
  await ready(page);
  await replaceSource(page, DOC);
  await expect(docTitle(page)).toHaveText("Tracked deck");
  await expect(page.locator(".docwalk-statusbar")).toContainText("6 slides");

  await page.locator(".reveal").focus();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
  }
  // The last slide's diagram is refused with a reason instead of drawn.
  await expect(page.locator(".reveal section.present .docwalk-diagnostic")).toContainText(
    "another site",
  );
  await page.waitForTimeout(500);
  expect(requested).toEqual([]);

  // Back to the last image slide: a click is the viewer's consent, for that image only.
  await page.keyboard.press("ArrowLeft");
  await page.locator(".reveal section.present img.docwalk-blocked-image").click();
  await expect.poll(() => requested).toEqual([`https://${TRACKER}/slide4.png`]);
});
