import { FileUp } from "lucide-react";
import { Button, FileTrigger } from "react-aria-components";
import "./inputs.css";
import { m } from "../paraglide/messages.js";
import { loadFromFile } from "./load";
import type { LoadResult } from "./types";

export interface OpenFileButtonProps {
  /** The loaded document or why it was refused (wrong type, too large, not UTF-8). */
  onLoad: (result: LoadResult) => void;
}

/** Opens a local Markdown or text file; the size cap and type check match the URL loader. */
export function OpenFileButton({ onLoad }: OpenFileButtonProps) {
  return (
    <FileTrigger
      acceptedFileTypes={[".md", ".markdown", ".txt", "text/markdown", "text/plain"]}
      onSelect={(files) => {
        const file = files?.[0];
        if (file) void loadFromFile(file).then(onLoad);
      }}
    >
      <Button className="docwalk-button docwalk-inputs-target">
        <FileUp size={16} aria-hidden="true" />
        <span className="docwalk-button-label">{m.open_file()}</span>
      </Button>
    </FileTrigger>
  );
}
