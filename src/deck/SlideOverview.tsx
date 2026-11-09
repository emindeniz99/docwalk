import { X } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  GridList,
  GridListItem,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { rich } from "../i18n/rich";
import { m } from "../paraglide/messages.js";
import { clonePages, type ClonedPage, type DeckController } from "./controller";
import { SLIDE_SIZE } from "./pages";
import { renameIds } from "./renameIds";
import "./overview.css";

interface SlideOverviewProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  controller: DeckController | null;
  current: string | null;
  onGoTo: (address: string) => void;
}

/**
 * Every slide as a thumbnail (O, or the grid button in the stage toolbar).
 * Arrow keys move through the grid, Enter or a click jumps to a slide and
 * closes, Escape closes and leaves the deck where it was. The thumbnails are
 * copies of the paginated pages the audience sees, so a split section shows
 * all of its pages and a flagged page shows its note.
 */
export function SlideOverview({
  isOpen,
  onOpenChange,
  controller,
  current,
  onGoTo,
}: SlideOverviewProps) {
  // Copied once per opening, so the thumbnails show the deck as it is now.
  const slides = useMemo(
    () => (isOpen && controller ? thumbnails(controller) : []),
    [isOpen, controller],
  );
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-overview-overlay"
    >
      <Modal className="docwalk-overview">
        <Dialog className="docwalk-overview-dialog">
          {({ close }) => (
            <OverviewBody
              slides={slides}
              current={current}
              onPick={(address) => {
                close();
                onGoTo(address);
              }}
              close={close}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * Copies of the pages whose ids are their own, so the open overview repeats
 * none of the deck's: headings, footnotes and each diagram's SVG with its
 * markers (decision 108).
 */
function thumbnails(controller: DeckController): ClonedPage[] {
  const pages = clonePages(controller);
  for (const [i, page] of pages.entries()) renameIds(page.element, `docwalk-overview-${i + 1}-`);
  return pages;
}

function OverviewBody({
  slides,
  current,
  onPick,
  close,
}: {
  slides: ClonedPage[];
  current: string | null;
  onPick: (address: string) => void;
  close: () => void;
}) {
  // Open on the current slide, so arrow keys start from where the talk is.
  // The rows mount after the dialog has taken focus, so the current row
  // takes it from its own ref, once per opening.
  const focused = useRef(false);
  const focusCurrent = useCallback((row: HTMLDivElement | null) => {
    if (!row || focused.current) return;
    focused.current = true;
    requestAnimationFrame(() => {
      row.focus();
      row.scrollIntoView({ block: "nearest" });
    });
  }, []);

  return (
    <>
      <header className="docwalk-overview-head">
        <Heading slot="title" className="docwalk-overview-title">
          {m.cmd_overview()}
        </Heading>
        <span className="docwalk-overview-count">{m.count_slides({ count: slides.length })}</span>
        {slides.length > 0 && (
          <p className="docwalk-overview-hint">
            {rich(m.overview_hint, { enter: <kbd>Enter</kbd>, esc: <kbd>Esc</kbd> })}
          </p>
        )}
        <Button className="docwalk-overview-close" aria-label={m.overview_close()} onPress={close}>
          <X size={18} aria-hidden="true" />
        </Button>
      </header>
      {/* An empty deck gets the hint the preview and Present show, not a grid to move through. */}
      {slides.length === 0 ? (
        <p className="docwalk-overview-empty">{m.app_stage_empty()}</p>
      ) : (
        <GridList
          aria-label={m.deck_label()}
          layout="grid"
          items={slides}
          onAction={(key) => onPick(String(key))}
          className="docwalk-overview-grid"
        >
          {(slide) => {
            const { info } = slide;
            const isCurrent = info.address === current;
            return (
              <GridListItem
                ref={isCurrent ? focusCurrent : undefined}
                id={info.address}
                // React Aria names the row from this. The title leads, so
                // type-ahead still finds a slide by its first letters.
                textValue={[
                  info.title,
                  info.page > 1 ? m.overview_row_page({ page: info.page }) : "",
                  m.overview_row_position({ current: info.index + 1, total: slides.length }),
                  info.flagged ? m.overview_row_note() : "",
                  isCurrent ? m.overview_row_current() : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
                className="docwalk-overview-item"
                data-current={isCurrent || undefined}
              >
                <Thumbnail element={slide.element} />
                <span className="docwalk-overview-caption">
                  <span className="docwalk-overview-n">{info.index + 1}</span>
                  <span className="docwalk-overview-name">{info.title}</span>
                  {info.page > 1 && <span className="docwalk-overview-page">· {info.page}</span>}
                  {info.flagged && (
                    <span className="docwalk-overview-note">{m.overview_note()}</span>
                  )}
                  {isCurrent && (
                    <span className="docwalk-overview-here">{m.overview_current()}</span>
                  )}
                </span>
              </GridListItem>
            );
          }}
        </GridList>
      )}
    </>
  );
}

/** A page copy scaled to its frame. Inert and hidden from assistive tech: the row's name says which slide it is. */
function Thumbnail({ element }: { element: HTMLElement }) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    // The copy still carries reveal.js's state: distant slides are
    // display: none and aria-hidden, the others are positioned.
    for (const attr of ["style", "hidden", "aria-hidden", "class"]) element.removeAttribute(attr);
    canvas.current?.replaceChildren(element);
  }, [element]);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setScale(el.clientWidth / SLIDE_SIZE.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={frame} className="docwalk-overview-frame" aria-hidden="true">
      <div
        ref={canvas}
        className="docwalk-overview-canvas"
        inert
        style={{
          width: SLIDE_SIZE.width,
          height: SLIDE_SIZE.height,
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}
