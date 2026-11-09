import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, ListBox, ListBoxItem } from "react-aria-components";
import { MirrorStore } from "../annotate/mirrorStore";
import { attachMirror } from "../annotate/mirrorView";
import { fitDiagrams, settled, slideBodySize } from "../deck/measure";
import { renderDiagrams } from "../deck/mermaid";
import { paginateSlide } from "../deck/paginate";
import { flagPages, SLIDE_SIZE, slideAddress } from "../deck/pages";
import { buildSlides } from "../deck/slides";
import { ariaLocale, useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { renderEmoji } from "../render/emoji";
import { highlightCode } from "../render/highlight";
import { renderMath } from "../render/math";
import { speakerNotes } from "../sectioning/notes";
import { parseMarkdown, sectionize, type LevelOption } from "../sectioning/sectionize";
import { useWakeLock } from "../shell/wakeLock";
import {
  connectPresenter,
  type ChannelFactory,
  type PresenterConnection,
  type PresenterState,
} from "./bridge";
import { formatClock } from "./pacing";
import { CountdownControls, PacingBar, useCountdown } from "./PacingControls";
import "./presenter.css";

const NO_ADDRESSES: string[] = [];
const NO_NOTES: string[] = [];

interface PresenterViewProps {
  /** Transport override for tests; defaults to BroadcastChannel. */
  channel?: ChannelFactory;
}

interface Previews {
  key: string;
  pages: ReadonlyMap<string, HTMLElement>;
  /** False while slides are still being built; `pages` holds those done so far. */
  done: boolean;
  error: boolean;
}

/**
 * The presenter window (decision 8). It never owns the deck: it mirrors the
 * audience window's state and sends navigation requests back. Previews are
 * rebuilt here from the same Markdown and level with the audience's own
 * pipeline, because a pasted document has no URL the window could load.
 */
export function PresenterView({ channel }: PresenterViewProps) {
  const [state, setState] = useState<PresenterState | null>(null);
  const [connected, setConnected] = useState(true);
  const [previews, setPreviews] = useState<Previews | null>(null);
  const connection = useRef<PresenterConnection | null>(null);
  // The audience window's laser and pen marks (decision 88), drawn over the current slide.
  const [mirror] = useState(() => new MirrorStore());
  const now = useNow();
  const [countdown, setCountdown] = useCountdown();
  // The screen stays on while this window is open (decision 80).
  useWakeLock(true);
  // The window's language follows the main tab's switch (a storage event).
  const locale = useLocale();

  useEffect(() => {
    const c = connectPresenter(setState, {
      onConnectionChange: setConnected,
      onMirror: (op) => mirror.apply(op),
      ...(channel ? { channel } : {}),
    });
    connection.current = c;
    return () => {
      c.close();
      connection.current = null;
    };
  }, [channel, mirror]);

  // The audience tab sends it on to phone remotes (decision 112): on each change, and
  // again with each heartbeat, so closing this window ends it there as it ends it here.
  useEffect(() => {
    connection.current?.setCountdown(countdown);
  }, [countdown]);

  const markdown = state?.markdown;
  const levelKey = state ? JSON.stringify(state.level) : null;
  // Previews carry slide chrome and overflow notes, so a language switch rebuilds them too.
  const key = markdown === undefined ? null : `${locale}\n${levelKey}\n${markdown}`;

  // Speaker notes (decision 79) come from the Markdown this window already
  // receives, so the bridge carries nothing extra and no other surface sees them.
  const notes = useMemo(
    () =>
      markdown === undefined || levelKey === null
        ? new Map<string, string[]>()
        : speakerNotes(sectionize(parseMarkdown(markdown), JSON.parse(levelKey) as LevelOption)),
    [markdown, levelKey],
  );

  const addresses = state?.addresses ?? NO_ADDRESSES;
  const index = state ? addresses.indexOf(state.current) : -1;
  const nextAddress = index >= 0 ? addresses[index + 1] : undefined;

  // The build reads which slides to do first as it goes, so a slide change
  // during a long build brings that slide's preview forward.
  const wanted = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    wanted.current = [state?.current, nextAddress].filter((a): a is string => Boolean(a));
  });

  // Rebuild only when the document or level changes, not on every slide change or heartbeat.
  useEffect(() => {
    if (markdown === undefined || levelKey === null || key === null) return;
    let cancelled = false;
    buildPreviews(markdown, JSON.parse(levelKey) as LevelOption, {
      wanted: () => wanted.current,
      stopped: () => cancelled,
      // Only between slides, after `stopped` said no: a replaced build never gets here.
      onProgress: (pages) => setPreviews({ key, pages: new Map(pages), done: false, error: false }),
    }).then(
      (pages) => !cancelled && pages && setPreviews({ key, pages, done: true, error: false }),
      () => !cancelled && setPreviews({ key, pages: new Map(), done: true, error: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [key, markdown, levelKey]);

  const ready = previews !== null && previews.key === key && previews.done;
  const pages = previews !== null && previews.key === key ? previews.pages : null;

  const items = useMemo(
    () => addresses.map((address, i) => ({ address, n: i + 1, title: titleOf(address, pages) })),
    [addresses, pages],
  );

  // Two windows that are both titled "docwalk" look the same in a
  // screen-share picker; the presenter must not share this one by mistake.
  useEffect(() => {
    const previous = document.title;
    document.title = m.presenter_window_title({}, { locale });
    return () => {
      document.title = previous;
    };
  }, [locale]);

  // Clickers send PageUp/PageDown; arrows match the audience deck. Listen in
  // the capture phase so these keys step the deck even while focus sits in
  // the slide list after a jump: the list itself would otherwise take
  // PageUp/PageDown for paging, and a clicker would silently stop working.
  // The vertical list does not use Left/Right, and keeps Up/Down/Home/End.
  const step = (direction: 1 | -1) => connection.current?.step(direction);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
      const direction =
        event.key === "ArrowRight" || event.key === "PageDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "PageUp"
            ? -1
            : 0;
      if (direction === 0) return;
      event.preventDefault();
      event.stopPropagation();
      connection.current?.step(direction);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Follow slide changes only: heartbeats repeat the state every few seconds
  // and must not snap back a list the presenter scrolled to look ahead.
  const list = useRef<HTMLDivElement>(null);
  const current = state?.current;
  useEffect(() => {
    if (current === undefined) return;
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const status = !state
    ? null
    : !connected
      ? m.presenter_disconnected()
      : !ready
        ? m.presenter_rendering()
        : previews.error
          ? m.presenter_previews_failed()
          : null;

  return (
    <div className="docwalk-presenter">
      <header className="docwalk-presenter-bar">
        <div className="docwalk-presenter-clock">
          <span className="docwalk-presenter-label">{m.presenter_elapsed()}</span>
          <span role="timer" aria-label={m.presenter_elapsed_time()}>
            {state ? formatElapsed(now - state.startedAt) : "0:00"}
          </span>
        </div>
        <div className="docwalk-presenter-clock">
          <span className="docwalk-presenter-label">{m.presenter_time()}</span>
          <time>
            {new Date(now).toLocaleTimeString(ariaLocale(locale), {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <div className="docwalk-presenter-clock">
          <span className="docwalk-presenter-label">{m.presenter_slide()}</span>
          <span aria-label={m.presenter_slide_position()}>
            {state ? `${index >= 0 ? index + 1 : "–"} / ${addresses.length}` : "– / –"}
          </span>
        </div>
        <CountdownControls countdown={countdown} onChange={setCountdown} now={now} />
        <div className="docwalk-presenter-nav">
          <Button
            className="docwalk-presenter-control"
            aria-label={m.presenter_previous()}
            isDisabled={!state || index === 0}
            onPress={() => step(-1)}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </Button>
          <Button
            className="docwalk-presenter-control"
            aria-label={m.presenter_next()}
            isDisabled={!state || (index >= 0 && index >= addresses.length - 1)}
            onPress={() => step(1)}
          >
            <ChevronRight size={22} aria-hidden="true" />
          </Button>
        </div>
        {countdown && state && (
          <PacingBar
            countdown={countdown}
            now={now}
            addresses={addresses}
            current={state.current}
          />
        )}
      </header>

      <p className="docwalk-presenter-status" role="status">
        {status}
      </p>

      {state ? (
        <main className="docwalk-presenter-main">
          <div className="docwalk-presenter-stage">
            <SlidePreview
              className="docwalk-presenter-current"
              label={m.presenter_now()}
              title={titleOf(state.current, pages)}
              page={pages?.get(state.current)}
              empty={ready ? m.presenter_no_preview() : ""}
              marks={{ store: mirror, address: state.current }}
            />
            <SpeakerNotes notes={notes.get(sectionOf(state.current)) ?? NO_NOTES} />
          </div>
          <aside className="docwalk-presenter-side">
            <SlidePreview
              className="docwalk-presenter-next"
              label={m.presenter_up_next()}
              title={nextAddress ? titleOf(nextAddress, pages) : m.presenter_end()}
              page={nextAddress ? pages?.get(nextAddress) : undefined}
              empty={ready && nextAddress ? m.presenter_no_preview() : ""}
            />
            <ListBox
              ref={list}
              aria-label={m.deck_label()}
              className="docwalk-presenter-list"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={index >= 0 ? [state.current] : []}
              onSelectionChange={(keys) => {
                if (keys === "all") return;
                const [picked] = [...keys];
                if (typeof picked === "string" && picked !== state.current) {
                  connection.current?.goTo(picked);
                }
              }}
              items={items}
            >
              {(item) => (
                <ListBoxItem
                  id={item.address}
                  textValue={item.title}
                  className="docwalk-presenter-item"
                >
                  <span className="docwalk-presenter-item-n">{item.n}</span>
                  <span>{item.title}</span>
                </ListBoxItem>
              )}
            </ListBox>
          </aside>
        </main>
      ) : (
        <main className="docwalk-presenter-waiting">
          <h1>{m.presenter_waiting_title()}</h1>
          <p>{m.presenter_waiting_body()}</p>
        </main>
      )}
    </div>
  );
}

/**
 * The current slide's speaker notes. They are text: React writes each one as
 * a text node, so a note can never become markup (rule 5). The panel is
 * always there, so the layout does not move from slide to slide.
 */
function SpeakerNotes({ notes }: { notes: readonly string[] }) {
  return (
    <section
      className="docwalk-presenter-notes"
      aria-labelledby="docwalk-presenter-notes-label"
      // Long notes scroll inside the panel, so the panel must take the keyboard.
      tabIndex={0}
    >
      <span id="docwalk-presenter-notes-label" className="docwalk-presenter-label">
        {m.presenter_notes()}
      </span>
      {notes.length > 0 ? (
        notes.map((note, i) => (
          // The list is replaced as a whole, so the position is the identity.
          // oxlint-disable-next-line react/no-array-index-key
          <p key={i} className="docwalk-presenter-note">
            {note}
          </p>
        ))
      ) : (
        <p className="docwalk-presenter-notes-empty">{m.presenter_notes_empty()}</p>
      )}
    </section>
  );
}

interface SlidePreviewProps {
  className: string;
  label: string;
  title: string;
  page: HTMLElement | undefined;
  empty: string;
  /** The audience window's laser and marks, drawn over this slide when it is the one at `address`. */
  marks?: { store: MirrorStore; address: string };
}

/**
 * A slide-sized clone of a page, scaled to fit its frame. The clone is inert:
 * the presenter looks at it, and diagram hosts inside must not take focus.
 */
function SlidePreview({ className, label, title, page, empty, marks }: SlidePreviewProps) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 0, x: 0, y: 0 });
  const markStore = marks?.store;
  const markAddress = marks?.address;

  // The overlay has the canvas's size and transform, so a mark sits where it sits on the slide.
  useEffect(() => {
    const el = overlay.current;
    if (!el || !markStore || markAddress === undefined) return;
    const view = attachMirror(el, markStore, () => markAddress);
    return () => view.destroy();
  }, [markStore, markAddress]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const scale = Math.min(
        el.clientWidth / SLIDE_SIZE.width,
        el.clientHeight / SLIDE_SIZE.height,
      );
      // Centred across, but top-aligned: the slide stays under its caption,
      // level with the next-slide preview beside it.
      setFit({ scale, x: (el.clientWidth - SLIDE_SIZE.width * scale) / 2, y: 0 });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    canvas.current?.replaceChildren(...(page ? [page.cloneNode(true)] : []));
  }, [page]);

  return (
    <figure className={`docwalk-presenter-preview ${className}`}>
      <figcaption>
        <span className="docwalk-presenter-label">{label}</span>
        <span className="docwalk-presenter-title">{title}</span>
      </figcaption>
      <div ref={frame} className="docwalk-presenter-frame">
        <div
          ref={canvas}
          className="docwalk-presenter-canvas"
          inert
          hidden={!page}
          style={{
            width: SLIDE_SIZE.width,
            height: SLIDE_SIZE.height,
            transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`,
          }}
        />
        {marks && (
          <div
            ref={overlay}
            className="docwalk-presenter-marks"
            hidden={!page}
            style={{
              width: SLIDE_SIZE.width,
              height: SLIDE_SIZE.height,
              transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`,
            }}
          />
        )}
        {!page && empty && <p className="docwalk-presenter-empty">{empty}</p>}
      </div>
    </figure>
  );
}

/**
 * Hands the main thread back for a turn. WebKit has no `scheduler.yield`;
 * a zero timeout is the portable fallback.
 */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}

interface BuildOptions {
  /** The addresses the presenter looks at now (current and next), read before each slide. */
  wanted: () => readonly string[];
  /** True once a newer document or level has replaced this build. */
  stopped: () => boolean;
  /**
   * Receives the pages built so far after each slide but the last, once the
   * wanted slides are among them.
   */
  onProgress: (pages: ReadonlyMap<string, HTMLElement>) => void;
}

/** The section id in a `<section-id>/<n>` address. */
const sectionOf = (address: string) => address.slice(0, address.lastIndexOf("/"));

/**
 * The audience's pipeline, run again here: sections, diagrams, fitting,
 * settling, pagination, overflow notes. The pages are slide-sized and do not depend on this
 * window's size, so they match the audience's addresses.
 *
 * It runs one slide at a time, the slides the presenter is looking at first,
 * and gives the main thread back between slides and between diagrams. In
 * WebKit the presenter window shares its main thread with the audience tab
 * that opened it, so a build in one piece froze the deck the room watches.
 * Returns the finished pages, or `null` when stopped.
 */
async function buildPreviews(
  markdown: string,
  level: LevelOption,
  { wanted, stopped, onProgress }: BuildOptions,
): Promise<Map<string, HTMLElement> | null> {
  const remaining = buildSlides(sectionize(parseMarkdown(markdown), level));
  const body = slideBodySize(SLIDE_SIZE);
  const seen = new Set<string>();
  const pages = new Map<string, HTMLElement>();
  while (remaining.length > 0) {
    const ids = wanted().map(sectionOf);
    const pick = ids.map((id) => remaining.findIndex((s) => s.dataset["docwalkId"] === id));
    const [slide] = remaining.splice(pick.find((i) => i >= 0) ?? 0, 1);
    if (!slide) break;
    // Kept off the page. Nothing here needs the slide laid out where it is:
    // diagrams are fitted from their viewBox, and pagination and the
    // overflow notes measure clones in boxes of their own. Attached (hidden,
    // off-screen), the slides made every one of those measurements lay them
    // out again in WebKit: about 4.5 s of pagination and notes for the
    // fixture, against about 1 s with them detached. A stopped build
    // colours no more code and renders no more diagrams.
    await Promise.all([
      highlightCode(slide, { stop: stopped }),
      renderMath(slide, { stop: stopped }),
      renderEmoji(slide, { stop: stopped }),
      renderDiagrams(slide, stopped, { seen, pause: yieldToEventLoop }),
    ]);
    fitDiagrams(slide, body);
    // Also a turn of the event loop: it waits for an animation frame.
    await settled(slide);
    if (stopped()) return null;
    const built = paginateSlide(slide, { size: SLIDE_SIZE });
    // The presenter must see the same notes the audience deck shows, or a
    // clipped slide or an unreadable diagram looks fine in the preview.
    flagPages(built, SLIDE_SIZE);
    for (const page of built) pages.set(slideAddress(page), page);
    // Current and next appear together, then the rest one by one.
    const pending = new Set(wanted().map(sectionOf));
    if (remaining.length > 0 && !remaining.some((s) => pending.has(s.dataset["docwalkId"] ?? ""))) {
      onProgress(pages);
    }
  }
  return pages;
}

function titleOf(address: string, pages: ReadonlyMap<string, HTMLElement> | null): string {
  const page = pages?.get(address);
  if (!page) return address;
  const title = page.dataset["title"] || address;
  const n = Number(page.dataset["page"] ?? 1);
  return n > 1 ? `${title} (${n})` : title;
}

export const formatElapsed = formatClock;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
