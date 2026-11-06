import { Download, FileCode, Images, Printer } from "lucide-react";
import { useState } from "react";
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

/** Export the deck (decision 9). Progress and results are announced in a live region next to the button. */
export function ExportMenu({ getOptions, isDisabled = false }: ExportMenuProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const run = async (job: Job) => {
    setBusy(true);
    try {
      // Inside the try: collecting the slides can throw too, and the viewer must hear about it.
      const options = getOptions();
      if (!options || options.slides.length === 0) {
        setStatus(m.export_empty());
      } else if (job === "pdf") {
        setStatus(m.export_preparing_print());
        await printDeck(options);
        setStatus("");
      } else if (job === "html") {
        setStatus(m.export_building_html());
        const name = htmlFileName(options.title);
        downloadBlob(await exportHtml(options), name);
        setStatus(m.export_downloaded({ name }));
      } else {
        setStatus(m.export_preparing_images());
        const files = await exportPng(options, {
          onSlide: (current, total) => setStatus(m.export_rendering_slide({ current, total })),
        });
        setStatus(m.export_downloaded_png({ count: files.length }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(m.export_failed({ reason: message }));
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
        {status}
      </span>
    </div>
  );
}
