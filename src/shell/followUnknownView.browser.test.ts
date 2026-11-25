import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { App } from "../App";
import { connectRoom, type RoomConnection } from "../remote/client";
import { chooseLocale } from "../i18n/locale";
import { createPresenterCredentials, formatJoinUrl } from "../remote/crypto";
import type { RemoteMessage } from "../remote/types";
import { releaseDraft } from "../share/draft";
import { encodeDoc } from "../share/fragment";
import { CHROME_IDLE_MS } from "./presentChrome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Decision 172, a follow screen whose presenter is on a view this build does
 * not know. The whole page runs (App with `?view=follow`) against a presenter
 * connection over an in-memory relay, because the decision is about what the
 * follower does with the state: keep following on slides, say why in the bar
 * it already has, and drop the note when the presenter's state stops saying
 * it. The presenter side of docwalk only ever sends "map" or nothing, so the
 * unknown view is sent by hand, as a later build would.
 */

const DOC = "# Follow checks\n\n## First point\n\nAlpha.\n\n## Second point\n\nBeta.\n";
// Never put into the page: the test checks the name does not show up in it.
const NEWER = "timeline-three";
const NOTES = {
  en: "The presenter uses a newer docwalk view. Reload the page to see it.",
  tr: "Sunumu yapan kişi docwalk'ın daha yeni bir görünümünü kullanıyor. Görmek için sayfayı yeniden yükleyin.",
};
const NOTE = NOTES.en;

/** A WebSocket that reaches only the other sockets on the same URL, like worker/room.ts. */
class RelaySocket {
  static all = new Set<RelaySocket>();
  readonly url: string;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url.split("?")[0]!;
    RelaySocket.all.add(this);
    setTimeout(() => this.emit("open", {}), 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send(data: string) {
    for (const other of RelaySocket.all) {
      if (other !== this && other.url === this.url) {
        setTimeout(() => other.emit("message", { data }), 0);
      }
    }
  }

  close(code = 1000) {
    RelaySocket.all.delete(this);
    setTimeout(() => this.emit("close", { code }), 0);
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let root: Root | null = null;
let presenter: RoomConnection | null = null;
const startUrl = location.href;

beforeEach(async () => {
  await page.viewport(1280, 800);
  vi.stubGlobal("WebSocket", RelaySocket);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  presenter?.close();
  presenter = null;
  RelaySocket.all.clear();
  vi.unstubAllGlobals();
  chooseLocale("en");
  history.replaceState(null, "", startUrl);
  document.body.replaceChildren();
  localStorage.clear();
  releaseDraft();
});

/** Opens a follow screen on a new room and returns what the presenter sends it. */
async function followScreen({ width = 1280, height = 800 } = {}) {
  await page.viewport(width, height);
  const creds = await createPresenterCredentials();
  const join = new URL(formatJoinUrl(`${location.origin}/`, "follow", creds));
  history.replaceState(null, "", `${join.pathname}${join.search}${join.hash}`);
  const link = `${location.origin}/#doc=${await encodeDoc(DOC)}`;

  const hellos: RemoteMessage[] = [];
  presenter = connectRoom({
    creds,
    role: "presenter",
    onMessage: (message) => {
      if (message.type === "hello") hellos.push(message);
    },
    onStatus: () => {},
  });

  const container = document.createElement("div");
  container.style.height = `${height}px`;
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(App)));
  // The follower says hello on every connect; a state sent before it would be lost.
  await expect.poll(() => hellos.length, { timeout: 30_000 }).toBeGreaterThan(0);

  const send = (current: string, view?: string) =>
    presenter!.send({
      type: "state",
      current,
      index: 0,
      total: 3,
      title: "Follow checks",
      docLink: link,
      docLinkTooLong: false,
      level: "auto",
      ...(view === undefined ? {} : { view }),
    } as RemoteMessage);
  return { container, send };
}

const address = (el: HTMLElement) => el.querySelector(".docwalk-preview-address")?.textContent;
const note = (el: HTMLElement, text = NOTE) =>
  [...el.querySelectorAll<HTMLElement>(".docwalk-preview-head [role=status]")].find(
    (p) => p.textContent === text,
  );
const chrome = (el: HTMLElement) => el.querySelector(".docwalk-app")?.getAttribute("data-chrome");
const slideBottom = (el: HTMLElement) =>
  el.querySelector(".docwalk-deck-pane .reveal .slides")!.getBoundingClientRect().bottom;
const idle = () => new Promise((resolve) => setTimeout(resolve, CHROME_IDLE_MS + 1000));

describe("a presenter on a view this build does not know (decision 172)", () => {
  // The same screen with a state that names no view: the control for the two tests below,
  // which would otherwise also fail for a harness that never reaches the follower.
  test("a state with no view shows its slide and no note", async () => {
    const { container, send } = await followScreen();
    await send("second-point/1");
    await expect.poll(() => address(container), { timeout: 30_000 }).toBe("second-point/1");
    expect(note(container)).toBeUndefined();
  }, 45_000);

  test("the follower stays on slides, keeps following, and shows a fixed note until the presenter's state stops naming the view", async () => {
    const { container, send } = await followScreen();

    await send("second-point/1", NEWER);
    await expect.poll(() => address(container), { timeout: 30_000 }).toBe("second-point/1");
    expect(note(container)).toBeDefined();
    // Slides, not the map; the follow screen is the same one.
    expect(container.querySelector(".docwalk-follow-map")).toBeNull();
    expect(container.querySelector(".docwalk-app")?.getAttribute("data-view")).toBe("follow");

    // Still following: a later section change moves it, and the note stays while the view does.
    await send("first-point/1", NEWER);
    await expect.poll(() => address(container)).toBe("first-point/1");
    expect(note(container)).toBeDefined();

    // The received name is data, never page content.
    expect(container.innerHTML).not.toContain(NEWER);

    // The presenter is back on slides: no view in the state, no note.
    await send("second-point/1");
    await expect.poll(() => address(container)).toBe("second-point/1");
    await expect.poll(() => note(container)).toBeUndefined();
  }, 45_000);

  test("a known view takes the note away too: the map is shown, not the note", async () => {
    const { container, send } = await followScreen();

    await send("first-point/1", NEWER);
    await expect.poll(() => note(container), { timeout: 30_000 }).toBeDefined();

    await send("first-point/1", "map");
    await expect.poll(() => container.querySelector(".docwalk-follow-map")).not.toBeNull();
    await expect.poll(() => note(container)).toBeUndefined();
  }, 45_000);

  test("the slide still fits the screen when the note appears: the bar leaves the overlay for a band and reveal.js is told", async () => {
    // Height-limited on purpose: a bar that takes a band shrinks the deck pane, and reveal.js
    // lays out only on a window resize, so without a nudge the slide hangs below the screen.
    const { container, send } = await followScreen({ height: 700 });
    await send("first-point/1");
    await expect.poll(() => address(container), { timeout: 30_000 }).toBe("first-point/1");
    await expect.poll(() => slideBottom(container)).toBeLessThanOrEqual(window.innerHeight);

    await send("first-point/1", NEWER);
    await expect.poll(() => note(container)).toBeDefined();
    await expect
      .poll(() => slideBottom(container), { timeout: 5_000 })
      .toBeLessThanOrEqual(window.innerHeight);
  }, 45_000);

  test("the bar that carries the note stays up when idle, as the bar above the map does; without a note it hides", async () => {
    // The hidden bar only fades to opacity 0, so the note would still be in the DOM:
    // the check is the bar's own state after the idle delay.
    const { container, send } = await followScreen();
    await send("first-point/1");
    await expect.poll(() => chrome(container), { timeout: 30_000 }).toBe("shown");
    await expect.poll(() => chrome(container), { timeout: CHROME_IDLE_MS + 3000 }).toBe("hidden");

    await send("first-point/1", NEWER);
    await expect.poll(() => note(container)).toBeDefined();
    await idle();
    expect(chrome(container)).toBeNull();
    expect(getComputedStyle(container.querySelector(".docwalk-preview-head")!).opacity).toBe("1");
  }, 45_000);

  test.each([["en"], ["tr"]] as const)(
    "the note is read in full on a phone, in %s: it wraps rather than ending in an ellipsis",
    async (locale) => {
      chooseLocale(locale);
      const { container, send } = await followScreen({ width: 390 });
      await send("first-point/1", NEWER);
      await expect.poll(() => note(container, NOTES[locale]), { timeout: 30_000 }).toBeDefined();
      const el = note(container, NOTES[locale])!;
      expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
      // The wrapped lines are not cut either: the box is as tall as its text.
      expect(el.scrollHeight).toBeLessThanOrEqual(el.clientHeight);
    },
    45_000,
  );
});
