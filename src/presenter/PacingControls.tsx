import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "react-aria-components";
import { m } from "../paraglide/messages.js";
import {
  formatRemaining,
  isOver,
  MAX_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
  PACING_STORAGE_KEY,
  paceOf,
  parseMinutes,
  pauseCountdown,
  readCountdown,
  remainingMs,
  resumeCountdown,
  slideShare,
  startCountdown,
  timeShare,
  writeCountdown,
  type Countdown,
} from "./pacing";

/**
 * The countdown and the pacing bar of the presenter window (decision 80). The
 * countdown is the presenter window's own clock, apart from the bridge's
 * `startedAt` that the Elapsed clock reads. It lives in `sessionStorage`, so
 * a reload keeps it and closing the window ends it; storage that is blocked
 * or full leaves a countdown that works and forgets on reload.
 */

function load(): Countdown | null {
  try {
    return readCountdown(sessionStorage.getItem(PACING_STORAGE_KEY));
  } catch {
    return null;
  }
}

function save(countdown: Countdown | null): void {
  try {
    if (countdown) sessionStorage.setItem(PACING_STORAGE_KEY, writeCountdown(countdown));
    else sessionStorage.removeItem(PACING_STORAGE_KEY);
  } catch {
    // Blocked or full: the countdown still runs, it only will not survive a reload.
  }
}

/** The countdown and the function that changes it; every change is stored. */
export function useCountdown(): [Countdown | null, (next: Countdown | null) => void] {
  const [countdown, setCountdown] = useState<Countdown | null>(load);
  const change = (next: Countdown | null) => {
    setCountdown(next);
    save(next);
  };
  return [countdown, change];
}

interface CountdownControlsProps {
  countdown: Countdown | null;
  onChange: (next: Countdown | null) => void;
  /** The tick of the window's clock, for the face. Buttons read the clock themselves. */
  now: number;
}

/** The minutes field before a countdown, and its face and buttons after. */
export function CountdownControls({ countdown, onChange, now }: CountdownControlsProps) {
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  if (!countdown) {
    return (
      <form
        className="docwalk-presenter-target"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const minutes = parseMinutes(text);
          const started = minutes === null ? null : startCountdown(minutes, Date.now());
          setInvalid(started === null);
          if (started) onChange(started);
        }}
      >
        <label htmlFor={fieldId} className="docwalk-presenter-label">
          {m.presenter_target_label()}
        </label>
        <div className="docwalk-presenter-target-row">
          <input
            id={fieldId}
            className="docwalk-presenter-target-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" className="docwalk-presenter-text-control">
            {m.presenter_target_start()}
          </Button>
        </div>
        {invalid && (
          <span id={errorId} className="docwalk-presenter-target-error">
            {m.presenter_target_invalid({ min: MIN_TARGET_MINUTES, max: MAX_TARGET_MINUTES })}
          </span>
        )}
      </form>
    );
  }

  const over = isOver(countdown, now);
  const running = countdown.startedAt !== null;
  return (
    <>
      <div className="docwalk-presenter-clock" data-over={over ? "true" : undefined}>
        <span className="docwalk-presenter-label docwalk-presenter-countdown-label">
          {over && <TriangleAlert size={14} aria-hidden="true" />}
          {over ? m.presenter_countdown_over() : m.presenter_countdown_left()}
        </span>
        <span role="timer" aria-label={m.presenter_countdown_left()}>
          {formatRemaining(remainingMs(countdown, now))}
        </span>
      </div>
      <div className="docwalk-presenter-countdown-buttons">
        <Button
          className="docwalk-presenter-text-control"
          onPress={() =>
            onChange(
              running
                ? pauseCountdown(countdown, Date.now())
                : resumeCountdown(countdown, Date.now()),
            )
          }
        >
          {running ? m.presenter_countdown_pause() : m.presenter_countdown_resume()}
        </Button>
        <Button
          className="docwalk-presenter-text-control"
          onPress={() => {
            // The field comes back with the last minutes in it: starting again is one press.
            setText(String(Math.round(countdown.targetMs / 60_000)));
            setInvalid(false);
            onChange(null);
          }}
        >
          {m.presenter_countdown_reset()}
        </Button>
      </div>
    </>
  );
}

interface PacingBarProps {
  countdown: Countdown;
  now: number;
  addresses: readonly string[];
  current: string;
}

/**
 * Two bars on one scale, the time used and the talk done, and the verdict in
 * words. Shown only when the current slide has a place in the address list;
 * a guess at a place would be worse than no bar.
 */
export function PacingBar({ countdown, now, addresses, current }: PacingBarProps) {
  const slides = slideShare(addresses, current);
  if (slides === null) return null;
  const time = timeShare(countdown, now);
  const over = isOver(countdown, now);
  const pace = paceOf(time, slides);
  const verdict = over
    ? m.presenter_countdown_over()
    : pace === "ahead"
      ? m.presenter_pace_ahead()
      : pace === "behind"
        ? m.presenter_pace_behind()
        : m.presenter_pace_on();
  return (
    <div
      className="docwalk-presenter-pacing"
      role="group"
      aria-label={m.presenter_pace_group()}
      data-pace={over ? "over" : pace}
    >
      <div className="docwalk-presenter-pace-bars">
        <PaceRow label={m.presenter_pace_time()} share={time} />
        <PaceRow label={m.presenter_pace_slides()} share={slides} />
      </div>
      <p className="docwalk-presenter-verdict" aria-live="polite">
        {(over || pace === "behind") && <TriangleAlert size={16} aria-hidden="true" />}
        {verdict}
      </p>
    </div>
  );
}

function PaceRow({ label, share }: { label: string; share: number }) {
  const percent = Math.round(share * 100);
  return (
    <div className="docwalk-presenter-pace-row">
      <span className="docwalk-presenter-label">{label}</span>
      <div
        className="docwalk-presenter-pace-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="docwalk-presenter-pace-fill" style={{ inlineSize: `${percent}%` }} />
      </div>
      <span className="docwalk-presenter-pace-value">{percent}%</span>
    </div>
  );
}
