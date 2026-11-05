import { useMemo, useState, type DragEvent } from "react";
import sample from "../fixtures/ledger-redesign.md?raw";
import { Deck } from "./deck/Deck";
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

  const plan = useMemo(() => sectionize(parseMarkdown(markdown), level), [markdown, level]);

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && /\.(md|markdown|txt)$/i.test(file.name)) setMarkdown(await file.text());
  };

  return (
    <div className="docwalk-app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="docwalk-toolbar">
        <strong>docwalk</strong>
        <label>
          Slides at{" "}
          <select
            value={String(level)}
            onChange={(e) => {
              const found = LEVELS.find((l) => String(l.value) === e.target.value);
              if (found) setLevel(found.value);
            }}
          >
            {LEVELS.map((l) => (
              <option key={l.label} value={String(l.value)}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
          {editing ? "Hide source" : "Paste Markdown"}
        </button>
        <span>Drop a .md file anywhere. Click a diagram to explore it.</span>
        {editing && (
          <textarea
            aria-label="Markdown source"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            spellCheck={false}
          />
        )}
      </header>
      <Deck plan={plan} />
    </div>
  );
}
