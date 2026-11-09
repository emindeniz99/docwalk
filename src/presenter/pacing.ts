import * as v from "valibot";

/**
 * The presenter window's countdown and pacing arithmetic (decision 80).
 * Every function takes the time as an argument and nothing reads the clock
 * here, so the numbers are tested without one. The module touches no DOM:
 * the Node-run unit tests import it.
 */

/** The target field takes whole minutes in this range. */
export const MIN_TARGET_MINUTES = 1;
export const MAX_TARGET_MINUTES = 600;

/** How far apart (as a share of the talk) the clock and the slides may drift and still read "on pace". */
export const PACE_TOLERANCE = 0.05;

/** The most time spent a phone remote is sent: 7 days (decision 112). */
export const MAX_SPENT_MS = 7 * 24 * 60 * 60_000;

/** Where the presenter window keeps its countdown across a reload. */
export const PACING_STORAGE_KEY = "docwalk-pacing";

const MINUTE_MS = 60_000;

/**
 * A countdown to a target. It is a stopwatch with a budget: `spentMs` is the
 * time used before the clock last started, and `startedAt` is the instant it
 * last started (a `Date.now()` value), or `null` while paused. Nothing else
 * is stored, so a reload computes the time spent from the clock alone.
 */
export interface Countdown {
  targetMs: number;
  spentMs: number;
  startedAt: number | null;
}

/**
 * A countdown as the phone remote gets it (decision 112): durations only,
 * because the phone's clock is not the laptop's.
 */
export interface RemoteCountdown {
  targetMs: number;
  spentMs: number;
  running: boolean;
}

/** Whole minutes in range, from what the presenter typed; `null` for anything else. */
export function parseMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return minutes >= MIN_TARGET_MINUTES && minutes <= MAX_TARGET_MINUTES ? minutes : null;
}

/** A running countdown of `minutes` that starts at `now`; `null` when the target is out of range. */
export function startCountdown(minutes: number, now: number): Countdown | null {
  if (!Number.isInteger(minutes) || minutes < MIN_TARGET_MINUTES || minutes > MAX_TARGET_MINUTES) {
    return null;
  }
  return { targetMs: minutes * MINUTE_MS, spentMs: 0, startedAt: now };
}

/** Time used so far. A system clock that moved back counts as no time since the start. */
export function spentMs(countdown: Countdown, now: number): number {
  const running = countdown.startedAt === null ? 0 : Math.max(0, now - countdown.startedAt);
  return countdown.spentMs + running;
}

export function pauseCountdown(countdown: Countdown, now: number): Countdown {
  if (countdown.startedAt === null) return countdown;
  return { ...countdown, spentMs: spentMs(countdown, now), startedAt: null };
}

export function resumeCountdown(countdown: Countdown, now: number): Countdown {
  if (countdown.startedAt !== null) return countdown;
  return { ...countdown, startedAt: now };
}

/** The target minus the time used; below zero once the presenter runs over. */
export function remainingMs(countdown: Countdown, now: number): number {
  return countdown.targetMs - spentMs(countdown, now);
}

/** True from the moment the time left reaches zero. */
export function isOver(countdown: Countdown, now: number): boolean {
  return remainingMs(countdown, now) <= 0;
}

/** The share of the target used, 0 to 1; it stops at 1 when the talk runs long. */
export function timeShare(countdown: Countdown, now: number): number {
  return Math.min(1, spentMs(countdown, now) / countdown.targetMs);
}

/**
 * How far through the talk the presenter is, 0 to 1, from the audience's
 * address list (slides are known by address, never by an index; rule 7). The
 * slide on screen counts as half done, so a deck of one slide reads 0.5 and
 * the bar never claims the talk has not begun or has ended. `null` when the
 * list is empty or does not hold the address.
 */
export function slideShare(addresses: readonly string[], current: string): number | null {
  const index = addresses.indexOf(current);
  return index < 0 ? null : (index + 0.5) / addresses.length;
}

export type Pace = "ahead" | "on-pace" | "behind";

/** Compares the slides' share with the clock's: within the tolerance either way is on pace. */
export function paceOf(time: number, slides: number): Pace {
  const drift = slides - time;
  // The epsilon keeps a drift of exactly the tolerance on pace despite float noise.
  if (Math.abs(drift) <= PACE_TOLERANCE + 1e-9) return "on-pace";
  return drift > 0 ? "ahead" : "behind";
}

/** `m:ss`, or `h:mm:ss` from an hour; never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(min).padStart(2, "0")}:${s}` : `${min}:${s}`;
}

/** The countdown as durations for the phone remote; the time spent is whole milliseconds, at most `MAX_SPENT_MS`. */
export function toRemoteCountdown(countdown: Countdown, now: number): RemoteCountdown {
  return {
    targetMs: countdown.targetMs,
    spentMs: Math.min(MAX_SPENT_MS, Math.round(spentMs(countdown, now))),
    running: countdown.startedAt !== null,
  };
}

/** The phone's countdown: a running clock counts on from `now`, the phone's own clock. */
export function fromRemoteCountdown(remote: RemoteCountdown, now: number): Countdown {
  return {
    targetMs: remote.targetMs,
    spentMs: remote.spentMs,
    startedAt: remote.running ? now : null,
  };
}

/** True when two countdowns hold the same values, so a heartbeat that repeats one changes nothing. */
export function sameCountdown(a: Countdown | null, b: Countdown | null): boolean {
  if (a === null || b === null) return a === b;
  return a.targetMs === b.targetMs && a.spentMs === b.spentMs && a.startedAt === b.startedAt;
}

/**
 * The share of the talk done from a slide's place and the deck's size, as
 * `slideShare` computes it from addresses; `null` for an empty deck.
 */
export function slideShareOf(index: number, total: number): number | null {
  return total > 0 ? (index + 0.5) / total : null;
}

/**
 * The time left as a clock: whole seconds toward zero, so `0:01` shows for
 * the last second, and a real minus sign (U+2212, which screen readers speak)
 * once at least a second below zero.
 */
export function formatRemaining(ms: number): string {
  const seconds = Math.trunc(ms / 1000);
  const clock = formatClock(Math.abs(seconds) * 1000);
  return seconds < 0 ? `−${clock}` : clock;
}

// A limit on the stored values, as for every other input (decision 46): the
// presenter window reads this from storage that a page script or an older
// build also writes, and the audience tab reads it from the presenter window's
// bridge request (decision 112).
export const CountdownSchema = v.object({
  targetMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(MIN_TARGET_MINUTES * MINUTE_MS),
    v.maxValue(MAX_TARGET_MINUTES * MINUTE_MS),
  ),
  spentMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  startedAt: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
});

export function writeCountdown(countdown: Countdown): string {
  return JSON.stringify(countdown);
}

/** The countdown a stored string holds, or `null` for anything that is not one. */
export function readCountdown(raw: string | null): Countdown | null {
  if (raw === null) return null;
  try {
    const parsed = v.safeParse(CountdownSchema, JSON.parse(raw));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}
