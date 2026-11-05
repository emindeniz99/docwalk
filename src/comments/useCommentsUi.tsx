import type { Root } from "mdast";
import { MessageSquare } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DeckController, SlideInfo } from "../deck/controller";
import type { LoadedDocument } from "../inputs/types";
import type { SectionPlan } from "../sectioning/sectionize";
import type { Command } from "../shell/CommandPalette";
import type { MoreAction } from "../shell/MoreMenu";
import type { Notice } from "../shell/useDocument";
import { useMediaQuery } from "../shell/useMediaQuery";
import { buildAnchorIndex, countBySection, type DiagramNodes } from "./anchors";
import { collectDiagramNodes } from "./diagramNodes";
import { CommentChip, CommentsToggle } from "./CommentControls";
import { markDiagramNodes, markHeadings } from "./markers";
import { encodeComments } from "./payload";
import { sidecarFileName } from "./sidecar";
import type { Anchor } from "./types";
import { useComments } from "./useComments";

// The panel (forms, lists, the sidecar writer) loads on first open, outside the first-load bundle.
const CommentsPanel = lazy(() =>
  import("./CommentsPanel").then((m) => ({ default: m.CommentsPanel })),
);

/** Below this width the shell stacks its panes, so the panel becomes a sheet. */
const SHEET = "(max-width: 900px)";

const NO_NODES: DiagramNodes = new Map();

export interface CommentsUiInput {
  doc: LoadedDocument | null;
  title: string;
  root: Root;
  plan: SectionPlan;
  controller: DeckController | null;
  current: SlideInfo | null;
  /** False on a follower screen and while presenting: no panel, no markers to act on. */
  enabled: boolean;
  /** The header moves secondary actions into the More menu on a phone. */
  phone: boolean;
  setNotice: (notice: Notice | null) => void;
  goTo: (address: string) => void;
}

/** Comment payload for the share dialog. */
export interface ShareComments {
  count: number;
  encode: () => Promise<string>;
}

/**
 * Everything the shell needs for comments (decision 55), so App only places
 * the pieces: the header toggle (or a More-menu item on a phone), a palette
 * command, the slide chip, outline counts, the panel, the share payload,
 * and markers on the deck and the document view.
 */
export function useCommentsUi({
  doc,
  title,
  root,
  plan,
  controller,
  current,
  enabled,
  phone,
  setNotice,
  goTo,
}: CommentsUiInput) {
  const sheet = useMediaQuery(SHEET);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [focusAnchor, setFocusAnchor] = useState<Anchor | null>(null);

  const show = useCallback((next: boolean, anchor: Anchor | null = null) => {
    if (next) setMounted(true);
    setFocusAnchor(anchor);
    setOpen(next);
    if (!next) {
      // The panel's buttons are gone: give focus back to the toggle.
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>("[data-comments-toggle]")?.focus(),
      );
    }
  }, []);

  const api = useComments({
    doc,
    onNotice: useCallback(
      (n) =>
        setNotice({
          ...n,
          ...(n.tone === "info"
            ? { action: { label: "Show comments", run: () => show(true) } }
            : {}),
        }),
      [setNotice, show],
    ),
  });

  const index = useMemo(() => buildAnchorIndex(root, plan), [root, plan]);
  const nodes = useMemo(
    () => (controller ? collectDiagramNodes(controller.stage(), index) : NO_NODES),
    [controller, index],
  );
  const counts = useMemo(
    () => countBySection(api.comments, index, nodes),
    [api.comments, index, nodes],
  );
  const openCount = useMemo(() => api.comments.filter((c) => !c.resolved).length, [api.comments]);

  useEffect(() => {
    if (controller) markDiagramNodes(controller.stage(), index, api.comments);
  }, [controller, index, api.comments]);

  // Document mode renders on its own; it reports each finished render here.
  const [article, setArticle] = useState<{ el: HTMLElement } | null>(null);
  const onDocumentRendered = useCallback((el: HTMLElement) => setArticle({ el }), []);
  useEffect(() => {
    if (!article) return;
    markHeadings(article.el, index, api.comments, (slug) => show(true, { kind: "heading", slug }));
    markDiagramNodes(article.el, index, api.comments);
  }, [article, index, api.comments, show]);

  const defaultAnchor: Anchor | null =
    current && index.bySlug.has(current.sectionId)
      ? { kind: "heading", slug: current.sectionId }
      : null;
  const currentCount = current ? (counts.get(current.sectionId) ?? 0) : 0;
  const label = open ? "Hide comments" : "Show comments";

  const toggle: ReactNode =
    enabled && !phone ? (
      <CommentsToggle isOpen={open} onChange={(next) => show(next)} count={openCount} />
    ) : null;
  const moreAction: MoreAction | null =
    enabled && phone
      ? {
          id: "comments",
          label: openCount > 0 ? `Comments (${openCount} open)` : "Comments",
          Icon: MessageSquare,
          run: () => show(true),
        }
      : null;
  const command: Command | null = enabled
    ? { id: "comments", label, run: () => show(!open) }
    : null;
  const chip: ReactNode =
    enabled && currentCount > 0 ? (
      <CommentChip count={currentCount} onPress={() => show(true, defaultAnchor)} />
    ) : null;

  const panel: ReactNode =
    enabled && mounted ? (
      <Suspense fallback={null}>
        <CommentsPanel
          isOpen={open}
          onClose={() => show(false)}
          sheet={sheet}
          api={api}
          index={index}
          nodes={nodes}
          defaultAnchor={defaultAnchor}
          focusAnchor={focusAnchor}
          onGoTo={(sectionId) => goTo(`${sectionId}/1`)}
          sidecarName={doc ? sidecarFileName(doc.source, title) : "document.comments.json"}
        />
      </Suspense>
    ) : null;

  const share: ShareComments = useMemo(
    () => ({ count: api.comments.length, encode: () => encodeComments(api.comments) }),
    [api.comments],
  );

  return {
    toggle,
    moreAction,
    command,
    chip,
    panel,
    outlineCounts: counts,
    share,
    markEdit: api.markEdit,
    onDocumentRendered,
  };
}
