import { describe, expect, test } from "vitest";
import * as v from "valibot";
import {
  CountdownSchema,
  formatClock,
  fromRemoteCountdown,
  formatRemaining,
  isOver,
  MAX_SPENT_MS,
  MAX_TARGET_MINUTES,
  PACE_TOLERANCE,
  paceOf,
  parseMinutes,
  pauseCountdown,
  readCountdown,
  remainingMs,
  resumeCountdown,
  slideShare,
  slideShareOf,
  spentMs,
  startCountdown,
  timeShare,
  toRemoteCountdown,
  writeCountdown,
  type Countdown,
} from "./pacing";

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** A countdown of `minutes` that started at T0. */
const started = (minutes: number): Countdown => {
  const countdown = startCountdown(minutes, T0);
  if (!countdown) throw new Error("a valid target must start");
  return countdown;
};

describe("the target field", () => {
  test("accepts whole minutes from 1 to the ceiling and nothing else, so a typo never starts a bogus clock", () => {
    expect(parseMinutes("20")).toBe(20);
    expect(parseMinutes(" 7 ")).toBe(7);
    expect(parseMinutes("1")).toBe(1);
    expect(parseMinutes(String(MAX_TARGET_MINUTES))).toBe(MAX_TARGET_MINUTES);
    for (const bad of ["", " ", "0", "-5", "1.5", "1,5", "abc", "20min", "1e2", "601", "0x10"]) {
      expect([bad, parseMinutes(bad)]).toEqual([bad, null]);
    }
  });

  test("a target outside the range starts no countdown", () => {
    expect(startCountdown(0, T0)).toBeNull();
    expect(startCountdown(MAX_TARGET_MINUTES + 1, T0)).toBeNull();
    expect(startCountdown(Number.NaN, T0)).toBeNull();
    expect(startCountdown(2.5, T0)).toBeNull();
  });
});

describe("the countdown clock", () => {
  test("at the start the whole target is left, and zero of it is used", () => {
    const c = started(10);
    expect(remainingMs(c, T0)).toBe(10 * MIN);
    expect(spentMs(c, T0)).toBe(0);
    expect(timeShare(c, T0)).toBe(0);
    expect(isOver(c, T0)).toBe(false);
  });

  test("exactly at the target the time left is zero and the countdown counts as over, so the warning appears on the dot", () => {
    const c = started(10);
    expect(remainingMs(c, T0 + 10 * MIN)).toBe(0);
    expect(isOver(c, T0 + 10 * MIN)).toBe(true);
    expect(isOver(c, T0 + 10 * MIN - 1)).toBe(false);
  });

  test("past the target the time left goes negative and keeps going, while the time share stops at 100%", () => {
    const c = started(10);
    expect(remainingMs(c, T0 + 12 * MIN)).toBe(-2 * MIN);
    expect(isOver(c, T0 + 12 * MIN)).toBe(true);
    expect(timeShare(c, T0 + 12 * MIN)).toBe(1);
  });

  test("a paused clock stands still however long the window stays open", () => {
    const paused = pauseCountdown(started(10), T0 + 3 * MIN);
    expect(spentMs(paused, T0 + 3 * MIN)).toBe(3 * MIN);
    expect(spentMs(paused, T0 + 60 * MIN)).toBe(3 * MIN);
    expect(remainingMs(paused, T0 + 60 * MIN)).toBe(7 * MIN);
    expect(isOver(paused, T0 + 60 * MIN)).toBe(false);
  });

  test("pausing twice or resuming a running clock changes nothing, so a double click cannot lose time", () => {
    const paused = pauseCountdown(started(10), T0 + 3 * MIN);
    expect(pauseCountdown(paused, T0 + 5 * MIN)).toEqual(paused);
    const running = resumeCountdown(paused, T0 + 8 * MIN);
    expect(resumeCountdown(running, T0 + 9 * MIN)).toEqual(running);
  });

  test("resuming adds only the time after the resume to what was spent before the pause", () => {
    const paused = pauseCountdown(started(10), T0 + 3 * MIN);
    const running = resumeCountdown(paused, T0 + 8 * MIN);
    expect(spentMs(running, T0 + 10 * MIN)).toBe(3 * MIN + 2 * MIN);
    expect(timeShare(running, T0 + 10 * MIN)).toBeCloseTo(0.5);
  });

  test("a system clock that jumps back never makes spent time negative or shrink the share below zero", () => {
    const c = started(10);
    expect(spentMs(c, T0 - 5 * MIN)).toBe(0);
    expect(timeShare(c, T0 - 5 * MIN)).toBe(0);
    expect(remainingMs(c, T0 - 5 * MIN)).toBe(10 * MIN);
  });
});

describe("the share of the talk done, from the address list", () => {
  const five = ["intro/1", "a/1", "b/1", "b/2", "c/1"];

  test("is null when there is nothing to measure: no slides, or an address the list does not hold", () => {
    expect(slideShare([], "a/1")).toBeNull();
    expect(slideShare(five, "missing/1")).toBeNull();
    expect(slideShare(five, "")).toBeNull();
  });

  test("counts the slide on screen as half done, so the first of five reads 10% and the last 90%", () => {
    expect(slideShare(five, "intro/1")).toBeCloseTo(0.1);
    expect(slideShare(five, "b/1")).toBeCloseTo(0.5);
    expect(slideShare(five, "c/1")).toBeCloseTo(0.9);
  });

  test("finds a continuation page by its address, not by the section it belongs to", () => {
    expect(slideShare(five, "b/2")).toBeCloseTo(0.7);
  });

  test("a deck of one slide reads 50% rather than dividing by zero or claiming it is finished", () => {
    expect(slideShare(["only/1"], "only/1")).toBe(0.5);
  });

  test("never reaches 0% or 100%, so the bar always shows where the talk is", () => {
    for (const a of five) {
      const share = slideShare(five, a);
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThan(1);
    }
  });
});

describe("ahead, on pace or behind", () => {
  test("compares the two shares and calls anything within the tolerance on pace, both ways, so a small drift is not nagged about", () => {
    expect(paceOf(0.5, 0.5)).toBe("on-pace");
    expect(paceOf(0.5, 0.5 + PACE_TOLERANCE)).toBe("on-pace");
    expect(paceOf(0.5, 0.5 - PACE_TOLERANCE)).toBe("on-pace");
  });

  test("the slides further along than the clock means ahead, and the clock further along than the slides means behind", () => {
    expect(paceOf(0.2, 0.5)).toBe("ahead");
    expect(paceOf(0.8, 0.5)).toBe("behind");
    expect(paceOf(0.5, 0.5 + PACE_TOLERANCE + 0.01)).toBe("ahead");
    expect(paceOf(0.5, 0.5 - PACE_TOLERANCE - 0.01)).toBe("behind");
  });

  test("at the start of a one-slide talk the presenter is ahead, and later in it behind (50% against the clock)", () => {
    const c = started(10);
    const share = slideShare(["only/1"], "only/1") ?? Number.NaN;
    expect(paceOf(timeShare(c, T0), share)).toBe("ahead");
    expect(paceOf(timeShare(c, T0 + 5 * MIN), share)).toBe("on-pace");
    expect(paceOf(timeShare(c, T0 + 9 * MIN), share)).toBe("behind");
  });
});

describe("the clock face", () => {
  test("reads like a stopwatch and shows a minus sign only once time is actually below zero", () => {
    expect(formatRemaining(90_000)).toBe("1:30");
    expect(formatRemaining(10 * MIN)).toBe("10:00");
    expect(formatRemaining(3_600_000)).toBe("1:00:00");
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(-500)).toBe("0:00");
    expect(formatRemaining(-5_000)).toBe("−0:05");
    expect(formatRemaining(-65_000)).toBe("−1:05");
    expect(formatRemaining(-3_725_000)).toBe("−1:02:05");
  });

  test("counts whole seconds down, so 0:01 stays on screen for the last second", () => {
    expect(formatRemaining(1_999)).toBe("0:01");
    expect(formatRemaining(1_000)).toBe("0:01");
    expect(formatRemaining(999)).toBe("0:00");
  });

  test("the plain clock is the elapsed clock's own format and clamps below zero", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(-5_000)).toBe("0:00");
  });
});

describe("what survives a reload", () => {
  test("round-trips a running and a paused countdown", () => {
    const running = started(20);
    expect(readCountdown(writeCountdown(running))).toEqual(running);
    const paused = pauseCountdown(running, T0 + MIN);
    expect(readCountdown(writeCountdown(paused))).toEqual(paused);
  });

  test("a running clock still counts the time the window spent reloading", () => {
    const stored = writeCountdown(started(20));
    const after = readCountdown(stored);
    expect(after && remainingMs(after, T0 + 4 * MIN)).toBe(16 * MIN);
  });

  test("refuses anything that is not a countdown, so a stale or hostile value starts nothing", () => {
    const bad = [
      null,
      "",
      "not json",
      "[]",
      "null",
      "{}",
      JSON.stringify({ targetMs: 0, spentMs: 0, startedAt: null }),
      JSON.stringify({ targetMs: -1, spentMs: 0, startedAt: null }),
      JSON.stringify({ targetMs: MAX_TARGET_MINUTES * MIN + 1, spentMs: 0, startedAt: null }),
      JSON.stringify({ targetMs: MIN, spentMs: -1, startedAt: null }),
      JSON.stringify({ targetMs: MIN, spentMs: "1", startedAt: null }),
      JSON.stringify({ targetMs: MIN, spentMs: 0, startedAt: "now" }),
      JSON.stringify({ targetMs: MIN, spentMs: 0 }),
    ];
    for (const raw of bad) expect([raw, readCountdown(raw)]).toEqual([raw, null]);
  });
});

describe("what the phone remote gets (decision 112)", () => {
  test("a running countdown becomes durations, and the phone counts on from its own clock", () => {
    const running = pauseCountdown(started(20), T0 + 5 * MIN);
    const resumed = resumeCountdown(running, T0 + 6 * MIN);
    // The laptop sends what is left of its clock, never the instant it started: the phone's clock differs.
    const sent = toRemoteCountdown(resumed, T0 + 7 * MIN);
    expect(sent).toEqual({ targetMs: 20 * MIN, spentMs: 6 * MIN, running: true });
    expect(Object.keys(sent).toSorted()).toEqual(["running", "spentMs", "targetMs"]);
    const PHONE_NOW = 42; // far from the laptop's clock
    const onPhone = fromRemoteCountdown(sent, PHONE_NOW);
    expect(onPhone).toEqual({ targetMs: 20 * MIN, spentMs: 6 * MIN, startedAt: PHONE_NOW });
    expect(remainingMs(onPhone, PHONE_NOW + MIN)).toBe(13 * MIN);
  });

  test("a paused countdown stays paused on the phone", () => {
    const paused = pauseCountdown(started(20), T0 + 5 * MIN);
    const sent = toRemoteCountdown(paused, T0 + 99 * MIN);
    expect(sent).toEqual({ targetMs: 20 * MIN, spentMs: 5 * MIN, running: false });
    const onPhone = fromRemoteCountdown(sent, 1_000);
    expect(onPhone.startedAt).toBeNull();
    expect(remainingMs(onPhone, 1_000_000)).toBe(15 * MIN);
  });

  test("spent time is a whole number of milliseconds, because the message schema takes no fraction", () => {
    const fractional: Countdown = { targetMs: 20 * MIN, spentMs: 1000.4, startedAt: T0 };
    expect(toRemoteCountdown(fractional, T0 + 0.3).spentMs).toBe(1001);
    expect(Number.isInteger(toRemoteCountdown(fractional, T0 + 0.3).spentMs)).toBe(true);
  });

  test("time spent is clamped to the message's ceiling, so a stored countdown from last week still sends", () => {
    const old: Countdown = { targetMs: MIN, spentMs: 0, startedAt: T0 };
    expect(toRemoteCountdown(old, T0 + 30 * 24 * 60 * MIN).spentMs).toBe(MAX_SPENT_MS);
  });

  test("the slide share from a count is the address list's (position + 0.5) / total", () => {
    expect(slideShareOf(0, 10)).toBe(0.05);
    expect(slideShareOf(9, 10)).toBe(0.95);
    expect(slideShareOf(0, 1)).toBe(0.5);
    const addresses = ["a/1", "b/1", "b/2", "c/1"];
    expect(slideShareOf(2, addresses.length)).toBe(slideShare(addresses, "b/2"));
  });

  test("an empty deck has no share, so the phone shows no verdict instead of a made-up one", () => {
    expect(slideShareOf(0, 0)).toBeNull();
  });

  test("the stored-countdown schema is exported and stays strict about the target's range", () => {
    expect(v.safeParse(CountdownSchema, started(5)).success).toBe(true);
    expect(v.safeParse(CountdownSchema, { targetMs: 1, spentMs: 0, startedAt: null }).success).toBe(
      false,
    );
  });
});
