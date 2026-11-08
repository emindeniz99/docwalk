import {
  expect,
  test as base,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

/**
 * `test` for specs that keep files in the origin private file system. WebKit
 * refuses `navigator.storage.getDirectory()` in Playwright's throwaway
 * contexts, as Safari does in a private window, so there each test gets a
 * persistent context with its own profile directory instead.
 */
export const opfsTest = base.extend({
  context: async (
    { context, browserName, playwright, baseURL, viewport, serviceWorkers },
    use,
    info,
  ) => {
    if (browserName !== "webkit") {
      await use(context);
      return;
    }
    const persistent = await playwright.webkit.launchPersistentContext(
      info.outputPath("webkit-profile"),
      { ...(baseURL ? { baseURL } : {}), viewport, serviceWorkers },
    );
    await use(persistent);
    await persistent.close();
  },
});

/** Opens `path` and waits until the deck has rendered and reported its slides. */
export async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, { timeout: 30_000 });
}

/**
 * Replaces the editor's text the way a paste does (one input event, no
 * key-by-key auto-indent). The selection is deleted first: in Firefox,
 * `insertText` over a selection only removed it and CodeMirror received no
 * text, while inserting into an empty editor works on every engine. (A
 * synthetic paste event is no way out: Firefox drops the constructor's
 * `clipboardData`.)
 */
export async function replaceSource(page: Page, markdown: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
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

/**
 * Offers "remote" from /api/health and plays the Worker's relay with
 * `routeWebSocket`: like worker/room.ts it forwards each frame, unread, to
 * every other socket in the context. `seats` lists the `?seat=` each socket
 * opened with, in order (null when it sent none, as a follower's does);
 * `dropFollowers` closes every socket without a seat from the server side,
 * and while `refuseFollowers` is true a follower socket is closed at once.
 */
export async function fakeRelay(context: BrowserContext) {
  await context.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, features: ["remote"] } }),
  );
  const sockets = new Map<WebSocketRoute, boolean>();
  const seats: (string | null)[] = [];
  const state = { refuseFollowers: false };
  // Control-key holders add `?seat=` (decision 71), so the room id is not the end of the URL.
  await context.routeWebSocket(/\/api\/remote\/[\w-]{22,64}(\?.*)?$/, (ws) => {
    const seat = new URL(ws.url()).searchParams.get("seat");
    seats.push(seat);
    if (seat === null && state.refuseFollowers) {
      void ws.close();
      return;
    }
    sockets.set(ws, seat !== null);
    ws.onMessage((frame) => {
      for (const other of sockets.keys()) if (other !== ws) other.send(frame);
    });
    ws.onClose(() => sockets.delete(ws));
  });
  return {
    seats,
    state,
    async dropFollowers() {
      for (const [ws, control] of [...sockets]) if (!control) await ws.close();
    },
  };
}

/** `fakeRelay` for specs that only need the seats. */
export async function fakeWorker(context: BrowserContext) {
  return (await fakeRelay(context)).seats;
}
