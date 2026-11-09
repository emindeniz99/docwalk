import { Check, Download, FileCode, Images, NotebookText, PenOff, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Separator,
  type Key,
} from "react-aria-components";
import { m } from "../paraglide/messages.js";
import { downloadBlob } from "./download";
import "./export.css";
import { htmlFileName } from "./filename";
import type { ExportOptions } from "./types";

export interface ExportMenuProps {
  /**
   * Called when the viewer picks an export: fresh clones of the paginated
   * slides (the exporters mutate them), with each slide's saved marks when
   * `withMarks` is true, and each section's speaker notes on its last slide
   * when `withNotes` is true (decision 114). `null` while there is no deck.
   */
  getOptions: (withMarks: boolean, withNotes: boolean) => ExportOptions | null;
  /** The document has saved marks (decision 105): the menu offers to leave them out. */
  hasMarks?: boolean;
  /** The document has speaker notes (decision 79): the menu offers a print that carries them. */
  hasNotes?: boolean;
  isDisabled?: boolean;
}

const INCLUDE_MARKS = "include-marks";

const ITEMS = [
  { id: "pdf", label: m.export_pdf, Icon: Printer },
  { id: "pdf-notes", label: m.export_pdf_notes, Icon: NotebookText },
  { id: "html", label: m.export_html, Icon: FileCode },
  { id: "png", label: m.export_png, Icon: Images },
] as const;

type Job = (typeof ITEMS)[number]["id"];
const isJob = (key: Key): key is Job => ITEMS.some((item) => item.id === key);

/**
 * How long a finished export's message stays. It floats over the controls
 * under the header, so it must not stay for good; a screen reader has read
 * the live region long before.
 */
export const STATUS_FADE_MS = 5000;

/** Export the deck (decision 9). Progress and results are announced in a live region next to the button. */
export function ExportMenu({
  getOptions,
  hasMarks = false,
  hasNotes = false,
  isDisabled = false,
}: ExportMenuProps) {
  const [busy, setBusy] = useState(false);
  // Saved marks go into exports unless the viewer leaves them out (decision 105); a reload asks again.
  const [withMarks, setWithMarks] = useState(true);
  // `fades`: the message reports a finished job and clears itself. Progress
  // stays until the job ends; a failure stays until the next export.
  const [status, setStatus] = useState({ text: "", fades: false });
  const say = (text: string, fades = false) => setStatus({ text, fades });

  useEffect(() => {
    if (!status.fades) return;
    const timer = window.setTimeout(() => setStatus({ text: "", fades: false }), STATUS_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Each exporter loads when its item is picked, so the page builder and
  // modern-screenshot stay out of the first load (decision 43).
  const run = async (job: Job) => {
    setBusy(true);
    try {
      // Inside the try: collecting the slides can throw too, and the viewer must hear about it.
      // Notes are a job, not a setting (decision 114): only their own item asks for them.
      const options = getOptions(hasMarks && withMarks, job === "pdf-notes");
      if (!options || options.slides.length === 0) {
        say(m.export_empty(), true);
      } else if (job === "pdf" || job === "pdf-notes") {
        say(m.export_preparing_print());
        const { printDeck } = await import("./print");
        await printDeck(options);
        say("");
      } else if (job === "html") {
        say(m.export_building_html());
        const { exportHtml } = await import("./html");
        const name = htmlFileName(options.title);
        downloadBlob(await exportHtml(options), name);
        say(m.export_downloaded({ name }), true);
      } else {
        say(m.export_preparing_images());
        const { exportPng } = await import("./png");
        const files = await exportPng(options, {
          onSlide: (current, total) => say(m.export_rendering_slide({ current, total })),
        });
        say(m.export_downloaded_png({ count: files.length }), true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      say(m.export_failed({ reason: message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="docwalk-export-menu-root">
      <MenuTrigger>
        <Button
          className="docwalk-button docwalk-export-trigger"
          isDisabled={isDisabled}
          isPending={busy}
        >
          <Download size={16} aria-hidden="true" />
          <span className="docwalk-button-label">{m.app_export()}</span>
        </Button>
        <Popover className="docwalk-popover" placement="bottom end">
          <Menu
            aria-label={m.app_export()}
            className="docwalk-menu docwalk-export-menu"
            onAction={(key) => {
              if (isJob(key)) void run(key);
            }}
          >
            <MenuSection>
              {ITEMS.filter(({ id }) => hasNotes || id !== "pdf-notes").map(
                ({ id, label, Icon }) => (
                  <MenuItem key={id} id={id} textValue={label()} className="docwalk-menu-item">
                    <Icon size={16} aria-hidden="true" />
                    {label()}
                  </MenuItem>
                ),
              )}
            </MenuSection>
            {hasMarks && <Separator className="docwalk-menu-separator" />}
            {hasMarks && (
              // A checkbox item, so its state is announced (as in the More menu).
              <MenuSection
                selectionMode="multiple"
                selectedKeys={withMarks ? [INCLUDE_MARKS] : []}
                onSelectionChange={(keys) =>
                  setWithMarks(keys === "all" || keys.has(INCLUDE_MARKS))
                }
              >
                <MenuItem
                  id={INCLUDE_MARKS}
                  textValue={m.export_include_marks()}
                  className="docwalk-menu-item"
                >
                  {({ isSelected }) => (
                    <>
                      {isSelected ? (
                        <Check size={16} aria-hidden="true" />
                      ) : (
                        <PenOff size={16} aria-hidden="true" />
                      )}
                      {m.export_include_marks()}
                    </>
                  )}
                </MenuItem>
              </MenuSection>
            )}
          </Menu>
        </Popover>
      </MenuTrigger>
      <span role="status" className="docwalk-export-status">
        {status.text}
      </span>
    </div>
  );
}
