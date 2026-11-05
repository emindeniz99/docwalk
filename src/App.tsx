import { useCallback, useMemo, useState, type DragEvent } from "react";
import sample from "../fixtures/ledger-redesign.md?raw";
import { Deck, type DeckReport } from "./deck/Deck";
import { parseMarkdown, sectionize, type LevelOption } from "./sectioning/sectionize";

const LEVELS: { label: string; value: LevelOption }[] = [
  { label: "Auto", value: "auto" },
  { label: "H1", value: 1 },
  { label: "H2", value: 2 },
  { label: "H3", value: 3 },
];

export function App() {
  const [markdown, setMarkdown] = useState(sample);
  const [level, setLevel] = useState<LevelOption>("auto");
  const [editing, setEditing] = useState(false);
  const [report, setReport] = useState<DeckReport | null>(null);

  const plan = useMemo(() => sectionize(parseMarkdown(markdown), level), [markdown, level]);
  const onReport = useCallback((r: DeckReport) => setReport(r), []);
  const resolved = plan.levels.length > 0 ? `H${plan.levels.join(", H")}` : "breaks only";

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && /\.(md|markdown|txt)$/i.test(file.name)) setMarkdown(await file.text());
  };

  return (
    <div className="docwalk-app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="docwalk-toolbar">
        <div className="docwalk-wordmark" aria-label="docwalk">
          doc<span>walk</span>
        </div>
        <label>
          Slides start at{" "}
          <select
            value={String(level)}
            onChange={(e) => {
              const found = LEVELS.find((l) => String(l.value) === e.target.value);
              if (found) setLevel(found.value);
            }}
          >
            {LEVELS.map((l) => (
              <option key={l.label} value={String(l.value)}>
                {l.value === "auto" ? `Auto (${resolved})` : l.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="docwalk-button"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
        >
          {editing ? "Hide source" : "Paste Markdown"}
        </button>
        {editing && (
          <textarea
            aria-label="Markdown source"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            spellCheck={false}
          />
        )}
      </header>
      <Deck plan={plan} onReport={onReport} />
      <footer className="docwalk-statusbar" aria-label="Status">
        <span>Slides at {level === "auto" ? `auto (${resolved})` : `H${String(level)}`}</span>
        <span>{report ? `${report.slides} slides` : "Rendering…"}</span>
        <span>{report ? `${report.overflowing.length} overflowing` : ""}</span>
        <span>{report ? `${report.diagramErrors} diagram errors` : ""}</span>
        <span style={{ marginLeft: "auto" }}>Nothing uploaded · works offline</span>
      </footer>
    </div>
  );
}
