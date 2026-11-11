import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { ariaLocale, useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { sketchKeyDocument } from "./identity";
import { deleteSketch, deleteSketches, listSketches, type SketchSummary } from "./store";

interface SavedSketchesProps {
  /** The key of the sketch on the canvas, or null when none is stored for it. It is never offered for deletion. */
  openKey: string | null;
  /** Escape closes the panel and not the dialog. */
  onClose: () => void;
}

const sizeText = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1000))} KB`;

/**
 * Every sketch stored in this browser, with the document it belongs to, its
 * size and its date (decision 98). Editing a diagram leaves its old sketch
 * behind, and nothing deletes it for the viewer: a stale sketch can be the
 * only copy of a drawing. The viewer deletes one, or all but the open one
 * after being asked.
 */
export function SavedSketches({ openKey, onClose }: SavedSketchesProps) {
  const locale = useLocale();
  const [items, setItems] = useState<SketchSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listSketches().then(
      (found) => {
        if (!cancelled) setItems(found);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Runs a delete, then lists the sketches again. */
  const remove = useCallback(async (job: () => Promise<void>) => {
    try {
      await job();
      setItems(await listSketches());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  const others = (items ?? []).filter((item) => item.key !== openKey);
  const date = new Intl.DateTimeFormat(ariaLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <section
      className="docwalk-sketch-store"
      aria-labelledby="docwalk-sketch-store-title"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <h3 id="docwalk-sketch-store-title" className="docwalk-sketch-store-title">
        {m.sketch_store_button()}
      </h3>
      <p className="docwalk-sketch-store-hint">{m.sketch_store_hint()}</p>
      {failed && (
        <p className="docwalk-diagnostic" role="alert">
          {m.sketch_store_failed()}
        </p>
      )}
      <ul className="docwalk-sketch-store-list">
        {(items ?? []).map((item) => {
          const document = sketchKeyDocument(item.key);
          return (
            <li key={item.key} className="docwalk-sketch-store-item">
              <span className="docwalk-sketch-store-doc">{document}</span>
              <span className="docwalk-sketch-store-meta">
                {sizeText(item.bytes)} · {date.format(item.savedAt)}
              </span>
              {item.key === openKey ? (
                <span className="docwalk-sketch-store-open">{m.sketch_store_open()}</span>
              ) : (
                <Button
                  className="docwalk-button"
                  aria-label={m.sketch_store_delete_label({ document })}
                  onPress={() => void remove(() => deleteSketch(item.key))}
                >
                  {m.sketch_store_delete()}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {items !== null && others.length > 0 && !confirming && (
        <Button className="docwalk-button" onPress={() => setConfirming(true)}>
          {m.sketch_store_delete_others()}
        </Button>
      )}
      {confirming && (
        <div className="docwalk-sketch-store-confirm">
          <p role="alert">{m.sketch_store_confirm()}</p>
          <div className="docwalk-sketch-store-actions">
            {/* The safe answer holds the focus. */}
            <Button className="docwalk-button" autoFocus onPress={() => setConfirming(false)}>
              {m.sketch_store_keep()}
            </Button>
            <Button
              className="docwalk-button"
              data-variant="primary"
              onPress={() => {
                setConfirming(false);
                void remove(() => deleteSketches(others.map((item) => item.key)));
              }}
            >
              {m.sketch_store_delete_them()}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
