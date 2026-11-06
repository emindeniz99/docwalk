import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ListBox, ListBoxItem } from "react-aria-components";
import { fitDiagrams, settled, slideBodySize } from "../deck/measure";
import { renderDiagrams } from "../deck/mermaid";
import { paginateSlide } from "../deck/paginate";
import { flagPages, SLIDE_SIZE, slideAddress } from "../deck/pages";
import { buildSlides } from "../deck/slides";
import { ariaLocale, useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { parseMarkdown, sectionize, type LevelOption } from "../sectioning/sectionize";
import {
  connectPresenter,
  type ChannelFactory,
  type PresenterConnection,
  type PresenterState,
} from "./bridge";
import "./presenter.css";

const NO_ADDRESSES: string[] = [];

interface PresenterViewProps {
  /** Transport override for tests; defaults to BroadcastChannel. */
  channel?: ChannelFactory;
}

interface Previews {
  key: string;
  pages: Map<string, HTMLElement>;
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
  const now = useNow();
  // The window's language follows the main tab's switch (a storage event).
  const locale = useLocale();

  useEffect(() => {
    const c = connectPresenter(setState, {
      onConnectionChange: setConnected,
      ...(channel ? { channel } : {}),
    });
    connection.current = c;
    return () => {
      c.close();
      connection.current = null;
    };
  }, [channel]);

  const markdown = state?.markdown;
  const levelKey = state ? JSON.stringify(state.level) : null;
  // Previews carry slide chrome and overflow notes, so a language switch rebuilds them too.
  const key = markdown === undefined ? null : `${locale}\n${levelKey}\n${markdown}`;

  // Rebuild only when the document or level changes, not on every slide change or heartbeat.
  useEffect(() => {
    if (markdown === undefined || levelKey === null || key === null) return;
    let cancelled = false;
    buildPreviews(markdown, JSON.parse(levelKey) as LevelOption).then(
      (pages) => !cancelled && setPreviews({ key, pages, error: false }),
      () => !cancelled && setPreviews({ key, pages: new Map(), error: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [key, markdown, levelKey]);

  const addresses = state?.addresses ?? NO_ADDRESSES;
  const index = state ? addresses.indexOf(state.current) : -1;
  const nextAddress = index >= 0 ? addresses[index + 1] : undefined;
  const ready = previews !== null && previews.key === key;
  const pages = ready ? previews.pages : null;

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
      </header>

      <p className="docwalk-presenter-status" role="status">
        {status}
      </p>

      {state ? (
        <main className="docwalk-presenter-main">
          <SlidePreview
            className="docwalk-presenter-current"
            label={m.presenter_now()}
            title={titleOf(state.current, pages)}
            page={pages?.get(state.current)}
            empty={ready ? m.presenter_no_preview() : ""}
          />
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

interface SlidePreviewProps {
  className: string;
  label: string;
  title: string;
  page: HTMLElement | undefined;
  empty: string;
}

/**
 * A slide-sized clone of a page, scaled to fit its frame. The clone is inert:
 * the presenter looks at it, and diagram hosts inside must not take focus.
 */
function SlidePreview({ className, label, title, page, empty }: SlidePreviewProps) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 0, x: 0, y: 0 });

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
        {!page && empty && <p className="docwalk-presenter-empty">{empty}</p>}
      </div>
    </figure>
  );
}

/**
 * The audience's pipeline, run again here: sections, diagrams, fitting,
 * settling, pagination, overflow notes. The pages are slide-sized and do not depend on this
 * window's size, so they match the audience's addresses.
 */
async function buildPreviews(
  markdown: string,
  level: LevelOption,
): Promise<Map<string, HTMLElement>> {
  const slides = buildSlides(sectionize(parseMarkdown(markdown), level));
  // Kept off the page. Nothing here needs the slides laid out where they
  // are: diagrams are fitted from their viewBox, and pagination and the
  // overflow notes measure clones in boxes of their own. Attached (hidden,
  // off-screen), the slides made every one of those measurements lay them
  // out again in WebKit: 4.7 s of pagination and notes for the fixture,
  // against 0.8 s with them detached.
  const box = document.createElement("div");
  box.append(...slides);
  await renderDiagrams(box);
  fitDiagrams(box, slideBodySize(SLIDE_SIZE));
  await settled(box);
  const pages = slides.flatMap((s) => paginateSlide(s, { size: SLIDE_SIZE }));
  // The presenter must see the same notes the audience deck shows, or a
  // clipped slide or an unreadable diagram looks fine in the preview.
  flagPages(pages, SLIDE_SIZE);
  return new Map(pages.map((p) => [slideAddress(p), p]));
}

function titleOf(address: string, pages: Map<string, HTMLElement> | null): string {
  const page = pages?.get(address);
  if (!page) return address;
  const title = page.dataset["title"] || address;
  const n = Number(page.dataset["page"] ?? 1);
  return n > 1 ? `${title} (${n})` : title;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(min).padStart(2, "0")}:${s}` : `${min}:${s}`;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
