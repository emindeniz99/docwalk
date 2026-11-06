import type { Element, Root as HastRoot } from "hast";
import type { Heading, Root, RootContent } from "mdast";
import rehypeGithubAlert from "rehype-github-alert";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { m } from "../paraglide/messages.js";

/** Class on an image whose remote `src` was moved to `data-src` until the viewer allows it. */
export const BLOCKED_IMAGE_CLASS = "docwalk-blocked-image";

export interface HtmlOptions {
  /** Load remote images directly (the "always load images" setting). Default: blocked. */
  loadRemoteImages?: boolean;
}

/**
 * GitHub's schema, plus one change: a `<style>` element is removed with its
 * contents, as `<script>` is, instead of being unwrapped. Unwrapped, its CSS
 * showed as text, and inside a `<table>` that text moved when the browser
 * re-parsed the output, so the sanitized tree was not the one the browser
 * built (the shape mutation XSS needs).
 */
export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? []), "style"],
};

/** Resolving a `src` against this base tells a same-origin path from a reference to another host. */
const PAGE_BASE = "https://docwalk.invalid/";
const PAGE_ORIGIN = new URL(PAGE_BASE).origin;

/**
 * Where an image `src` would be fetched from when that is another host, or
 * null when it stays on the page's own origin. Resolved with the browser's
 * own URL rules, so `//host`, `/\host` and `\\host` count as other hosts,
 * exactly as the browser would fetch them. An unparsable value counts as
 * remote, so it stays blocked.
 */
export function remoteImageUrl(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src, PAGE_BASE);
  } catch {
    return src;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return null;
  return url.origin === PAGE_ORIGIN ? null : url.href;
}

/**
 * Remote images leak the viewer's IP address to the image host, and docwalk
 * has no proxy. So the sanitizer is the gate (decision 33): it moves a
 * remote `src` to `data-src` and makes the placeholder a button, and the
 * page loads it only after a click (`src/render/remoteImages.ts`) or when
 * the setting allows it. Same-origin sources pass.
 */
export function rehypeBlockRemoteImages(options: HtmlOptions = {}) {
  return (tree: HastRoot) => {
    if (options.loadRemoteImages) return;
    visit(tree, "element", (node: Element) => {
      // GitHub's schema keeps `<picture><source srcset>` from raw HTML, and the
      // browser fetches a matching candidate as soon as it renders. Any remote
      // candidate drops the `srcset`, so the picture falls back to its `<img>`,
      // which this gate handles below. Every comma- or space-separated token
      // is checked: stricter than the browser's srcset parser, so no URL it
      // could fetch slips past as part of a "descriptor".
      if (node.tagName === "source") {
        const srcset = node.properties["srcSet"];
        const tokens = (Array.isArray(srcset) ? srcset.join(",") : String(srcset ?? ""))
          .split(/[\s,]+/)
          .filter(Boolean);
        if (tokens.some((t) => remoteImageUrl(t) !== null)) delete node.properties["srcSet"];
        return;
      }
      if (node.tagName !== "img") return;
      const src = node.properties["src"];
      if (typeof src !== "string") return;
      const remote = remoteImageUrl(src);
      if (remote === null) return;
      node.properties["dataSrc"] = remote;
      delete node.properties["src"];
      const classes = Array.isArray(node.properties["className"])
        ? node.properties["className"]
        : [];
      node.properties["className"] = [...classes, BLOCKED_IMAGE_CLASS];
      const alt = typeof node.properties["alt"] === "string" ? node.properties["alt"] : "";
      const host = URL.canParse(remote) ? new URL(remote).host : m.render_another_site();
      const label = alt ? m.render_load_image_alt({ alt, host }) : m.render_load_image({ host });
      node.properties["role"] = "button";
      node.properties["tabIndex"] = 0;
      node.properties["ariaLabel"] = label;
      node.properties["title"] = label;
    });
  };
}

export interface RenderContext extends HtmlOptions {
  /** Anchors from `headingIds`, written on each heading as `id="user-content-<anchor>"`, as GitHub does. */
  headingIds?: ReadonlyMap<Heading, string>;
  /**
   * The document's link and footnote definitions. A slide renders only its
   * own section, so a reference whose definition sits elsewhere would show
   * as literal `[text][ref]` without them. Unused ones render nothing.
   */
  definitions?: readonly RootContent[];
  /**
   * Put before footnote ids and links (`#<prefix>fn-1`), so the footnotes of
   * two slides in one deck never share an id. Empty in document mode.
   */
  footnotePrefix?: string;
}

/**
 * Render mdast nodes to HTML the way GitHub would:
 *
 * 1. remark-rehype, keeping raw HTML;
 * 2. rehype-raw parses that HTML into the tree, BEFORE the sanitizer, so the
 *    sanitizer sees real elements and keeps only what GitHub's schema allows
 *    (`details`, `kbd`, `sup`, `img width` …);
 * 3. rehype-sanitize with hast-util-sanitize's default (GitHub) schema,
 *    which also prefixes ids with `user-content-`;
 * 4. rehype-github-alert turns `> [!NOTE]` quotes into alerts. It runs after
 *    the sanitizer (decision 25), so the alert markup it adds is ours and the
 *    schema needs no class or SVG allowances that raw HTML could then forge;
 * 5. the remote image gate (decision 33).
 *
 * DOMPurify runs again in the browser before insertion (`src/deck/purify.ts`).
 */
export function nodesToHtml(nodes: RootContent[], options: RenderContext = {}): string {
  const { headingIds, definitions, footnotePrefix = "" } = options;
  let children = nodes;
  if (definitions) {
    children = [...nodes.filter((n) => !definitions.includes(n)), ...definitions];
  }
  if (headingIds) children = children.map((n) => withHeadingId(n, headingIds));
  const root: Root = { type: "root", children };
  const render = (rawHtml: typeof rehypeRaw | typeof rehypeDropRaw) => {
    const processor = unified()
      // The sanitizer adds the `user-content-` prefix; remark-rehype's own
      // default prefix would double it and break every footnote link.
      .use(remarkRehype, {
        allowDangerousHtml: true,
        clobberPrefix: footnotePrefix,
        // GitHub's footnote chrome, in the UI language; the footnotes themselves are content.
        footnoteLabel: m.render_footnotes(),
        footnoteBackLabel: (reference, rereference) =>
          m.render_footnote_back({
            reference: `${reference + 1}${rereference > 1 ? `-${rereference}` : ""}`,
          }),
      })
      .use(rawHtml)
      .use(rehypePrefixFootnoteLabel, footnotePrefix)
      .use(rehypeSanitize, SANITIZE_SCHEMA)
      .use(rehypeGithubAlert)
      .use(rehypeLocalizeAlertTitles)
      .use(rehypeBlockRemoteImages, options)
      .use(rehypeStringify);
    // remark-rehype builds a new tree, so a failed run leaves `root` intact for the retry.
    return processor.stringify(processor.runSync(root) as HastRoot);
  };
  try {
    return render(rehypeRaw);
  } catch {
    // hast-util-from-parse5 throws on some markup (a <template> inside SVG
    // or MathML). Hostile input must not take the whole deck down, so this
    // render keeps the Markdown and drops the raw HTML.
    return render(rehypeDropRaw);
  }
}

/** The alert titles rehype-github-alert writes in English, in the UI language. */
const ALERT_TITLES: Record<string, () => string> = {
  note: m.alert_note,
  tip: m.alert_tip,
  important: m.alert_important,
  warning: m.alert_warning,
  caution: m.alert_caution,
};

/**
 * rehype-github-alert has no option for its titles, so the title text it
 * added (the last child of `.markdown-alert-title`) is replaced here. It runs
 * right after that plugin, so the markup is the plugin's, never the author's.
 */
function rehypeLocalizeAlertTitles() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element) => {
      const classes = node.properties["className"];
      if (!Array.isArray(classes) || !classes.includes("markdown-alert")) return;
      const kind =
        classes
          .map(String)
          .find((c) => c !== "markdown-alert")
          ?.slice(15) ?? "";
      const title = ALERT_TITLES[kind];
      const head = node.children[0];
      const text = head?.type === "element" ? head.children.at(-1) : undefined;
      if (title && text?.type === "text") text.value = title();
    });
  };
}

/** Removes raw HTML nodes: the fallback when parsing them fails. */
function rehypeDropRaw() {
  return (tree: HastRoot) => {
    visit(tree, "raw", (_node, index, parent) => {
      if (!parent || typeof index !== "number") return undefined;
      parent.children.splice(index, 1);
      return index;
    });
  };
}

/** A copy of a heading that renders with its anchor as `id`; the parsed tree is shared, so it is never mutated. */
function withHeadingId(node: RootContent, ids: ReadonlyMap<Heading, string>): RootContent {
  const id = node.type === "heading" ? ids.get(node) : undefined;
  if (node.type !== "heading" || id === undefined) return node;
  return { ...node, data: { ...node.data, hProperties: { ...node.data?.hProperties, id } } };
}

/**
 * mdast-util-to-hast names the footnote heading `footnote-label` whatever the
 * prefix, and every reference points at it with `aria-describedby`. Two
 * slides with footnotes would then share that id, so it gets the prefix too.
 */
function rehypePrefixFootnoteLabel(prefix: string) {
  return (tree: HastRoot) => {
    if (!prefix) return;
    const label = "footnote-label";
    visit(tree, "element", (node: Element) => {
      if (node.properties["id"] === label) node.properties["id"] = `${prefix}${label}`;
      const described = node.properties["ariaDescribedBy"];
      if (Array.isArray(described)) {
        node.properties["ariaDescribedBy"] = described.map((v) =>
          v === label ? `${prefix}${label}` : v,
        );
      }
    });
  };
}
