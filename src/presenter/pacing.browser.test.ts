import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { DISCONNECT_AFTER_MS, type ChannelFactory } from "./bridge";
import { PACING_STORAGE_KEY } from "./pacing";
import { PresenterView } from "./PresenterView";

/**
 * The presenter window's countdown and pacing bar (decision 80), in a real
 * browser with a clock the test owns: `Date` and the timers are faked, so a
 * minute passes in one call.
 */

const MARKDOWN = [
  "# Pace talk",
  "",
  "Cover.",
  ...["One", "Two", "Three", "Four"].flatMap((t) => ["", `## ${t}`, "", `Text ${t}.`]),
].join("\n");
// Five slides: the cover and four sections.
const ADDRESSES = sectionize(parseMarkdown(MARKDOWN), "auto").sections.map((s) => `${s.id}/1`);
const NOW = 1_700_000_000_000;
const MIN = 60_000;
const FAKED = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

let root: Root | null = null;

beforeEach(() => {
  sessionStorage.removeItem(PACING_STORAGE_KEY);
  vi.useFakeTimers({ toFake: [...FAKED] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  sessionStorage.removeItem(PACING_STORAGE_KEY);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(channel: ChannelFactory): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(h(PresenterView, { channel }));
  return container;
}

function fakeChannel() {
  const listeners: ((data: unknown) => void)[] = [];
  const factory: ChannelFactory = () => ({
    postMessage: () => {},
    listen: (listener) => listeners.push(listener),
    close: () => {
      listeners.length = 0;
    },
  });
  return {
    factory,
    async deliver(current: string) {
      // Not `expect.poll`: with fake timers on, it moves the clock 50 ms per try.
      for (let tries = 0; tries < 500 && listeners.length === 0; tries++) await macrotask();
      expect(listeners.length).toBeGreaterThan(0);
      for (const listener of listeners) {
        listener({
          type: "state",
          markdown: MARKDOWN,
          level: "auto",
          current,
          addresses: ADDRESSES,
          startedAt: NOW,
        });
      }
    },
  };
}

/**
 * Lets React commit what a click or a timer changed. React renders in a
 * macrotask of its own (a message-channel task, which the fake clock leaves
 * alone), so the test lets two of those pass before it reads the page.
 */
const macrotask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", () => resolve(), { once: true });
    channel.port1.start();
    channel.port2.postMessage(0);
  });
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await macrotask();
  await macrotask();
};
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

const button = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === name);
const press = async (el: HTMLElement, name: string) => {
  const target = button(el, name);
  if (!target) throw new Error(`no "${name}" button`);
  target.click();
  await flush();
};
const input = (el: HTMLElement) =>
  el.querySelector<HTMLInputElement>(".docwalk-presenter-target input");
async function setTarget(el: HTMLElement, text: string) {
  const field = input(el);
  if (!field) throw new Error("no target field");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}
async function start(el: HTMLElement, minutes: string) {
  await setTarget(el, minutes);
  await press(el, "Start");
}
// The countdown's timer under either name: it becomes "Over time" past zero (decision 135).
const left = (el: HTMLElement) =>
  el.querySelector('[role="timer"][aria-label="Time left"], [role="timer"][aria-label="Over time"]')
    ?.textContent ?? null;
const bar = (el: HTMLElement, name: string) =>
  el.querySelector<HTMLElement>(`[role="progressbar"][aria-label="${name}"]`);
const verdict = (el: HTMLElement) =>
  el.querySelector(".docwalk-presenter-verdict")?.textContent?.trim() ?? null;
const pacing = (el: HTMLElement) => el.querySelector(".docwalk-presenter-pacing");

describe("the countdown in the presenter window", () => {
  test("shows only the target field, and no pacing bar, until a target is set", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    await flush();
    expect(input(el)).not.toBeNull();
    expect(left(el)).toBeNull();
    expect(pacing(el)).toBeNull();
    expect(button(el, "Pause")).toBeUndefined();
  });

  test("starts counting down from the minutes typed and ticks each second", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    await start(el, "20");
    expect(left(el)).toBe("20:00");
    await tick(1_000);
    expect(left(el)).toBe("19:59");
    await tick(59_000);
    expect(left(el)).toBe("19:00");
    // The field is gone while a target runs: one way to change it, Reset.
    expect(input(el)).toBeNull();
  });

  test("pause holds the time, resume goes on from where it stopped, and the time between does not count", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    await start(el, "10");
    await tick(2 * MIN);
    await press(el, "Pause");
    expect(left(el)).toBe("8:00");
    await tick(5 * MIN);
    expect(left(el)).toBe("8:00");
    expect(button(el, "Pause")).toBeUndefined();

    await press(el, "Resume");
    await tick(MIN);
    expect(left(el)).toBe("7:00");
  });

  test("reset drops the target, the clock face and the pacing bar, and keeps the last minutes in the field", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    await start(el, "15");
    await tick(3 * MIN);
    expect(pacing(el)).not.toBeNull();

    await press(el, "Reset");
    expect(left(el)).toBeNull();
    expect(pacing(el)).toBeNull();
    expect(input(el)?.value).toBe("15");
    expect(sessionStorage.getItem(PACING_STORAGE_KEY)).toBeNull();

    // Starting again begins from the full target.
    await press(el, "Start");
    expect(left(el)).toBe("15:00");
  });

  test("a target that is not whole minutes from 1 to 600 starts nothing and says why", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    for (const bad of ["", "0", "601", "2.5", "abc"]) {
      await start(el, bad);
      const field = input(el);
      const message = document.getElementById(field?.getAttribute("aria-describedby") ?? "");
      expect([bad, left(el), field?.getAttribute("aria-invalid")]).toEqual([bad, null, "true"]);
      expect(message?.textContent).toMatch(/1.*600/);
    }
    expect(sessionStorage.getItem(PACING_STORAGE_KEY)).toBeNull();
    // A valid value clears the complaint and starts.
    await start(el, "5");
    expect(left(el)).toBe("5:00");
  });

  test("past the target the time goes negative and the label, the verdict and an icon say so, not only a colour", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    await start(el, "2");
    await tick(2 * MIN - 1_000);
    expect(left(el)).toBe("0:01");
    expect(el.textContent).toContain("Time left");
    expect(el.querySelector('[data-over="true"]')).toBeNull();

    await tick(1_000);
    expect(left(el)).toBe("0:00");
    await tick(5_000);
    expect(left(el)).toBe("−0:05");
    expect(el.textContent).toContain("Over time");
    expect(el.textContent).not.toContain("Time left");
    expect(verdict(el)).toContain("Over time");
    expect(el.querySelector('[data-over="true"] svg')).not.toBeNull();
    // It keeps counting below zero.
    await tick(MIN);
    expect(left(el)).toBe("−1:05");
  });
});

describe("the pacing bar", () => {
  test("shows time used and slides done as percentages, and the slide share follows the slide", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[0] as string);
    await start(el, "10");
    expect(bar(el, "Time used")?.getAttribute("aria-valuenow")).toBe("0");
    // The cover of five: (0 + 0.5) / 5.
    expect(bar(el, "Slides")?.getAttribute("aria-valuenow")).toBe("10");

    await tick(3 * MIN);
    expect(bar(el, "Time used")?.getAttribute("aria-valuenow")).toBe("30");
    expect(pacing(el)?.textContent).toContain("30%");

    await channel.deliver(ADDRESSES[3] as string);
    await flush();
    // (3 + 0.5) / 5
    expect(bar(el, "Slides")?.getAttribute("aria-valuenow")).toBe("70");
    expect(pacing(el)?.textContent).toContain("70%");
  });

  test("says in words whether the presenter is ahead, on pace or behind", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[2] as string);
    await start(el, "10");
    // Slide share 50%, time 0%.
    expect(verdict(el)).toBe("Ahead of schedule");
    await tick(5 * MIN);
    expect(verdict(el)).toBe("On pace");
    await tick(3 * MIN);
    expect(verdict(el)).toBe("Behind schedule");
    await channel.deliver(ADDRESSES[4] as string);
    await flush();
    // Slide share 90% against time 80%: ahead by 10 points.
    expect(verdict(el)).toBe("Ahead of schedule");
  });

  test("is hidden while the current address is not in the list, rather than guessing a place", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver("nowhere/1");
    await start(el, "10");
    expect(left(el)).toBe("10:00");
    expect(pacing(el)).toBeNull();
  });

  test("the time bar stops at 100% when the talk runs long", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[4] as string);
    await start(el, "1");
    await tick(5 * MIN);
    expect(bar(el, "Time used")?.getAttribute("aria-valuenow")).toBe("100");
    expect(verdict(el)).toContain("Over time");
  });
});

describe("reload and a lost audience window", () => {
  test("a reloaded window keeps the countdown, and counts the time the reload took", async () => {
    const first = fakeChannel();
    const el = mount(first.factory);
    await first.deliver(ADDRESSES[1] as string);
    await start(el, "10");
    await tick(2 * MIN);
    root?.unmount();
    root = null;
    el.remove();

    // The window is gone for 30 s, then opens again.
    vi.setSystemTime(NOW + 2 * MIN + 30_000);
    const second = fakeChannel();
    const again = mount(second.factory);
    await second.deliver(ADDRESSES[1] as string);
    await flush();
    expect(left(again)).toBe("7:30");
    expect(button(again, "Pause")).toBeDefined();
  });

  test("a reloaded window keeps a paused countdown paused", async () => {
    const first = fakeChannel();
    const el = mount(first.factory);
    await first.deliver(ADDRESSES[1] as string);
    await start(el, "10");
    await tick(2 * MIN);
    await press(el, "Pause");
    root?.unmount();
    root = null;
    el.remove();

    vi.setSystemTime(NOW + 60 * MIN);
    const second = fakeChannel();
    const again = mount(second.factory);
    await second.deliver(ADDRESSES[1] as string);
    await flush();
    expect(left(again)).toBe("8:00");
    expect(button(again, "Resume")).toBeDefined();
  });

  test("a stored value that is not a countdown is ignored, and the field shows", async () => {
    sessionStorage.setItem(PACING_STORAGE_KEY, '{"targetMs":"soon"}');
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    await flush();
    expect(left(el)).toBeNull();
    expect(input(el)).not.toBeNull();
  });

  test("storage that refuses to save still gives a working countdown", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[1] as string);
    await start(el, "10");
    await tick(MIN);
    expect(left(el)).toBe("9:00");
    await press(el, "Pause");
    expect(button(el, "Resume")).toBeDefined();
  });

  test("when the audience window goes silent the countdown runs on and the bar keeps the last slide, with the disconnected line explaining", async () => {
    const channel = fakeChannel();
    const el = mount(channel.factory);
    await channel.deliver(ADDRESSES[2] as string);
    await start(el, "10");
    await tick(DISCONNECT_AFTER_MS + 1_000);
    expect(el.querySelector('[role="status"]')?.textContent).toMatch(/disconnected/i);
    expect(left(el)).toBe("9:54");
    expect(bar(el, "Slides")?.getAttribute("aria-valuenow")).toBe("50");
    await tick(2 * MIN);
    expect(left(el)).toBe("7:54");
    expect(bar(el, "Slides")?.getAttribute("aria-valuenow")).toBe("50");
    expect(verdict(el)).toBeTruthy();
  });
});
