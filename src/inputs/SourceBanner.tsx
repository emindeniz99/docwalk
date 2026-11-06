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
import { rich } from "../i18n/rich";
import { m } from "../paraglide/messages.js";
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
      return { Icon: ClipboardPaste, label: m.source_paste() };
    case "file":
      return {
        Icon: FileText,
        label: rich(m.source_file, { name: <strong>{source.name}</strong> }),
      };
    case "url":
      return {
        Icon: Globe,
        label: rich(m.source_url, { host: <strong>{hostOf(source.url)}</strong> }),
      };
    case "repo":
      return {
        Icon: FolderGit2,
        label: (
          <>
            {rich(m.source_repo, { repo: <strong>{source.repo}</strong>, path: source.path })}
            {source.ref === null ? null : ` @ ${source.ref}`}
          </>
        ),
      };
    case "fragment":
      return { Icon: Share2, label: m.source_fragment() };
    // App shows workspace files with src/workspace/WorkspaceBanner (save state, Save button).
    case "workspace":
      return {
        Icon: FileText,
        label: rich(m.source_workspace, { path: <strong>{source.path}</strong> }),
      };
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
          {m.source_confirm_title({ host })}
        </h2>
        <p>{m.source_confirm_body()}</p>
        <p>
          <code>{confirm.url}</code>
        </p>
        <div className="docwalk-inputs-actions">
          {/* The prompt appears without a click; focus tells keyboard and screen-reader users it is there. */}
          <Button
            autoFocus
            data-variant="primary"
            className="docwalk-button docwalk-inputs-target"
            onPress={() => onLoad?.()}
          >
            {m.source_load()}
          </Button>
          <Button className="docwalk-button docwalk-inputs-target" onPress={() => onCancel?.()}>
            {m.cancel()}
          </Button>
        </div>
      </section>
    );
  }
  const description = source ? describe(source) : null;
  if (!description) return null;
  const { Icon, label } = description;
  return (
    <p className="docwalk-source-banner">
      <Icon size={14} aria-hidden="true" />
      <span className="docwalk-source-label">{label}</span>
    </p>
  );
}
