import { Download, FileCode, Images, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Menu, MenuItem, MenuTrigger, Popover, type Key } from "react-aria-components";
import { m } from "../paraglide/messages.js";
import { downloadBlob } from "./download";
import "./export.css";
import { htmlFileName } from "./filename";
import { exportHtml } from "./html";
import { exportPng } from "./png";
import { printDeck } from "./print";
import type { ExportOptions } from "./types";

export interface ExportMenuProps {
  /**
   * Called when the viewer picks an export: fresh clones of the paginated
   * slides (the exporters mutate them). `null` while there is no deck.
   */
  getOptions: () => ExportOptions | null;
  isDisabled?: boolean;
}

const ITEMS = [
  { id: "pdf", label: m.export_pdf, Icon: Printer },
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
export function ExportMenu({ getOptions, isDisabled = false }: ExportMenuProps) {
  const [busy, setBusy] = useState(false);
  // `fades`: the message reports a finished job and clears itself. Progress
  // stays until the job ends; a failure stays until the next export.
  const [status, setStatus] = useState({ text: "", fades: false });
  const say = (text: string, fades = false) => setStatus({ text, fades });

  useEffect(() => {
    if (!status.fades) return;
    const timer = window.setTimeout(() => setStatus({ text: "", fades: false }), STATUS_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  const run = async (job: Job) => {
    setBusy(true);
    try {
      // Inside the try: collecting the slides can throw too, and the viewer must hear about it.
      const options = getOptions();
      if (!options || options.slides.length === 0) {
        say(m.export_empty(), true);
      } else if (job === "pdf") {
        say(m.export_preparing_print());
        await printDeck(options);
        say("");
      } else if (job === "html") {
        say(m.export_building_html());
        const name = htmlFileName(options.title);
        downloadBlob(await exportHtml(options), name);
        say(m.export_downloaded({ name }), true);
      } else {
        say(m.export_preparing_images());
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
            {ITEMS.map(({ id, label, Icon }) => (
              <MenuItem key={id} id={id} textValue={label()} className="docwalk-menu-item">
                <Icon size={16} aria-hidden="true" />
                {label()}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
      <span role="status" className="docwalk-export-status">
        {status.text}
      </span>
    </div>
  );
}
