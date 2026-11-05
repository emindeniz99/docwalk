import {
  ClipboardPaste,
  FileText,
  FolderGit2,
  Globe,
  Share2,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import { Button } from "react-aria-components";
import "./inputs.css";
import type { DocumentSource } from "./types";

export interface SourceBannerProps {
  /** Where the current document came from; the sample shows no banner. */
  source: DocumentSource | null;
  /**
   * An untrusted `?src=` address waiting for consent (a `needs-confirmation`
   * load error). While set, the prompt replaces the banner and nothing is fetched.
   */
  confirm?: { url: string; host: string } | null;
  onLoad?: () => void;
  onCancel?: () => void;
}

/** The ASCII host of an address: an IDN lookalike shows as `xn--…`, not as the name it imitates. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describe(source: DocumentSource): { Icon: LucideIcon; label: ReactNode } | null {
  switch (source.kind) {
    case "sample":
      return null;
    case "paste":
      return { Icon: ClipboardPaste, label: "Pasted · saved in this browser" };
    case "file":
      return {
        Icon: FileText,
        label: (
          <>
            Opened from file <strong>{source.name}</strong>
          </>
        ),
      };
    case "url":
      return {
        Icon: Globe,
        label: (
          <>
            Loaded from <strong>{hostOf(source.url)}</strong>
          </>
        ),
      };
    case "repo":
      return {
        Icon: FolderGit2,
        label: (
          <>
            From GitHub <strong>{source.repo}</strong> · {source.path}
            {source.ref === null ? null : ` @ ${source.ref}`}
          </>
        ),
      };
    case "fragment":
      return { Icon: Share2, label: "Opened from a shared link" };
  }
}

/**
 * Says where the document came from (decision 6), and asks before fetching
 * from any host other than raw GitHub content. All text goes in as React
 * text nodes; nothing from the address is parsed as HTML.
 */
export function SourceBanner({ source, confirm, onLoad, onCancel }: SourceBannerProps) {
  const titleId = useId();
  if (confirm) {
    const host = hostOf(confirm.url);
    return (
      <section className="docwalk-source-confirm" aria-labelledby={titleId}>
        <h2 id={titleId} className="docwalk-source-confirm-title">
          <ShieldAlert size={18} aria-hidden="true" />
          Load a document from {host}?
        </h2>
        <p>
          docwalk loads raw.githubusercontent.com and gist.githubusercontent.com directly. This link
          points elsewhere; load it only if you trust where it came from.
        </p>
        <p>
          <code>{confirm.url}</code>
        </p>
        <div className="docwalk-inputs-actions">
          <Button
            data-variant="primary"
            className="docwalk-button docwalk-inputs-target"
            onPress={() => onLoad?.()}
          >
            Load
          </Button>
          <Button className="docwalk-button docwalk-inputs-target" onPress={() => onCancel?.()}>
            Cancel
          </Button>
        </div>
      </section>
    );
  }
  const description = source ? describe(source) : null;
  if (!description) return null;
  const { Icon, label } = description;
  return (
    <aside className="docwalk-source" aria-label="Document source">
      <Icon size={14} aria-hidden="true" />
      <span className="docwalk-source-label">{label}</span>
    </aside>
  );
}
