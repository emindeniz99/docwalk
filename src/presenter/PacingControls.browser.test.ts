import { createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { PACING_STORAGE_KEY, startCountdown, type Countdown } from "./pacing";
import { CountdownControls, useCountdown } from "./PacingControls";

/**
 * What a screen-reader or keyboard user of the presenter window's countdown
 * gets (decision 135, refining 80): the timer's name follows its visible
 * label, a refused target is announced, and Start and Reset leave focus on
 * the control that replaces them instead of on `<body>`.
 */

const MIN = 60_000;
const T0 = 1_700_000_000_000;

let root: Root | null = null;

beforeEach(() => sessionStorage.removeItem(PACING_STORAGE_KEY));

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  sessionStorage.removeItem(PACING_STORAGE_KEY);
});

function mount(element: ReturnType<typeof h>): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(element);
  return container;
}

/** The controls with the presenter window's own state, as PresenterView wires them. */
function Stateful() {
  const [countdown, setCountdown] = useCountdown();
  // The face is not under test here, so its clock need not tick.
  const [now] = useState(Date.now);
  return h(CountdownControls, { countdown, onChange: setCountdown, now });
}

function timerName(countdown: Countdown, now: number) {
  const el = mount(h(CountdownControls, { countdown, onChange: () => {}, now }));
  return () => el.querySelector('[role="timer"]')?.getAttribute("aria-label");
}

const button = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const field = (el: HTMLElement) => el.querySelector<HTMLInputElement>("input");

async function typeMinutes(el: HTMLElement, text: string) {
  const input = field(el);
  if (!input) throw new Error("no target field");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => field(el)?.value).toBe(text);
}

/** Focus a button, then press it, as a keyboard user does before the press. */
function press(target: HTMLButtonElement | undefined) {
  if (!target) throw new Error("no such button");
  target.focus();
  target.click();
}

describe("the countdown's timer name", () => {
  test("says Time left before zero, as the visible label does", async () => {
    const name = timerName(startCountdown(2, T0)!, T0 + MIN);
    await expect.poll(name).toBe("Time left");
  });

  test("says Over time past zero, so a screen reader hears what the eye reads", async () => {
    const name = timerName(startCountdown(2, T0)!, T0 + 3 * MIN);
    await expect.poll(name).toBe("Over time");
  });
});

describe("a refused target", () => {
  test("is announced, and the field points at the message", async () => {
    const el = mount(h(Stateful));
    await expect.poll(() => field(el)).not.toBeNull();
    await typeMinutes(el, "0");
    press(button(el, "Start"));
    await expect.poll(() => field(el)?.getAttribute("aria-invalid")).toBe("true");
    const message = document.getElementById(field(el)?.getAttribute("aria-describedby") ?? "");
    expect(message?.textContent).toMatch(/1.*600/);
    // Without a role the message appears silently: the user pressed Start and heard nothing.
    expect(message?.getAttribute("role")).toBe("alert");
  });
});

describe("focus after Start and Reset", () => {
  test("Start leaves focus on Pause, the first control that replaces the form", async () => {
    const el = mount(h(Stateful));
    await expect.poll(() => field(el)).not.toBeNull();
    await typeMinutes(el, "10");
    press(button(el, "Start"));
    await expect.poll(() => button(el, "Pause")).toBeDefined();
    await expect.poll(() => document.activeElement).toBe(button(el, "Pause"));
  });

  test("Reset leaves focus on the minutes field, which holds the last target", async () => {
    const el = mount(h(Stateful));
    await expect.poll(() => field(el)).not.toBeNull();
    await typeMinutes(el, "10");
    press(button(el, "Start"));
    await expect.poll(() => button(el, "Reset")).toBeDefined();
    press(button(el, "Reset"));
    await expect.poll(() => field(el)?.value).toBe("10");
    await expect.poll(() => document.activeElement).toBe(field(el));
  });
});
