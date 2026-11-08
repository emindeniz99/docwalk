import type { Element, Root as HastRoot } from "hast";
import type { Heading, Root, RootContent } from "mdast";
import rehypeGithubAlert from "rehype-github-alert";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { m } from "../paraglide/messages.js";

/** Class on an image whose remote `src` was moved to `data-docwalk-src` until the viewer allows it. */
export const BLOCKED_IMAGE_CLASS = "docwalk-blocked-image";

/**
 * Class on the `<span>` around a blocked image. While the image is still a
 * button, the span is the visible placeholder: its alt text and "Load image
 * from <host>" as generated content (no text nodes, so nothing is added to
 * the slide's text or an export), with the image laid over it transparently
 * as the click and focus target. Loaded or exported, the image is no longer
 * a button and the span is a plain inline wrapper.
 */
export const BLOCKED_IMAGE_FRAME_CLASS = "docwalk-blocked-frame";

/**
 * Where a blocked image keeps its remote URL. Not `data-src`: reveal.js
 * copies `img[data-src]` into `src` on every slide near the current one,
 * which loaded blocked images without a click (decision 33).
 */
export const BLOCKED_IMAGE_SRC = "data-docwalk-src";

export interface HtmlOptions {
  /** Load remote images directly (the "always load images" setting). Default: blocked. */
  loadRemoteImages?: boolean;
}

/**
 * GitHub's schema, with `<style>`, `<svg>` and `<math>` removed with their
 * contents, as `<script>` is, instead of being unwrapped. Unwrapped, a
 * style's CSS showed as text, and inside a `<table>` that text moved when the
 * browser re-parsed the output. Unwrapped foreign content left its children
 * where the HTML parser had not put them (`<p><svg><summary>` kept the
 * `<summary>` in the `<p>`, which a re-parse closes). Either way the
 * sanitized tree was not the one the browser built: the shape mutation XSS
 * needs. Neither element is in GitHub's schema; loose text inside one is
 * the only thing that no longer shows.
 */
export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? []), "style", "svg", "math"],
  // GitHub's schema keeps a disabled checkbox for task lists. docwalk draws
  // those from the Markdown tree instead (decision 86), so no `<input>` of
  // the document's own gets through either. The one attribute is the
  // placeholder `rehypeMarkTasks` leaves; `rehypeDrawTasks` checks it.
  tagNames: (defaultSchema.tagNames ?? []).filter((name) => name !== "input"),
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.["span"] ?? []), "dataDocwalkTask"],
  },
};

/** The schema for a tree it already sanitized: ids carry their `user-content-` prefix, so none is added again. */
const SETTLE_SCHEMA = { ...SANITIZE_SCHEMA, clobberPrefix: "" };
const reparse = unified().use(rehypeRaw).use(rehypeSanitize, SETTLE_SCHEMA);
const serialize = unified().use(rehypeStringify);
/** Every input found so far settles in one extra pass; more than this is treated as hostile. */
const SETTLE_PASSES = 3;

/**
 * Re-parses the sanitized tree until serializing and parsing it again
 * changes nothing, so the tree docwalk approved is the one the browser
 * builds (decisions 42, 60). The schema unwraps every element it does not
 * know (`<marquee>`, `<object>`, `<button>`, `<center>`, `<u>` …), but the
 * parser had kept a `<p>`, `<li>`, `<dd>` or heading open across it: after
 * unwrapping, `<p><marquee><dd>x` is `<p><dd>x</dd></p>`, which a re-parse
 * turns into `<p></p><dd>x</dd><p></p>`. Stripping those elements instead
 * would drop text GitHub shows. Input that will not settle throws, and the
 * render falls back to dropping its raw HTML.
 */
function rehypeSettle() {
  return (tree: HastRoot) => {
    let html = serialize.stringify(tree);
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      const raw = { type: "raw", value: html } as unknown as HastRoot["children"][number];
      const again = reparse.runSync({ type: "root", children: [raw] }) as HastRoot;
      const next = serialize.stringify(again);
      if (next === html) return;
      tree.children = again.children;
      html = next;
    }
    throw new Error("Raw HTML did not settle into a stable tree");
  };
}

/**
 * Resolving a `src` against these bases tells a same-origin path from a
 * reference to another host. Both page schemes, because a special scheme
 * with no slashes is relative only on a page of that scheme:
 * `https:host/x` is a path on an https page and the absolute
 * `https://host/x` on an http one (`wrangler dev`, `vite preview`, a LAN
 * self-host). A value stays same-origin only if it does on both, so any
 * explicit scheme counts as another host, whatever the real page's scheme.
 */
const PAGE_BASES = ["https://docwalk.invalid/", "http://docwalk.invalid/"].map((b) => new URL(b));

/**
 * Where an image `src` would be fetched from when that is another host, or
 * null when it stays on the page's own origin. Resolved with the browser's
 * own URL rules, so `//host`, `/\host` and `\\host` count as other hosts,
 * exactly as the browser would fetch them. An unparsable value counts as
 * remote, so it stays blocked.
 */
export function remoteImageUrl(src: string): string | null {
  for (const base of PAGE_BASES) {
    let url: URL;
    try {
      url = new URL(src, base);
    } catch {
      return src;
    }
    if (url.protocol === "data:" || url.protocol === "blob:") return null;
    if (url.origin !== base.origin) return url.href;
  }
  return null;
}

/**
 * Remote images leak the viewer's IP address to the image host, and docwalk
 * has no proxy. So the sanitizer is the gate (decision 33): it moves a
 * remote `src` to `data-docwalk-src` and makes the placeholder a button, and the
 * page loads it only after a click (`src/render/remoteImages.ts`) or when
 * the setting allows it. Same-origin sources pass.
 */
export function rehypeBlockRemoteImages(options: HtmlOptions = {}) {
  return (tree: HastRoot) => {
    if (options.loadRemoteImages) return;
    visit(tree, "element", (node: Element, index, parent) => {
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
      node.properties[BLOCKED_IMAGE_SRC] = remote;
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
      if (!parent || index === undefined) return;
      parent.children[index] = {
        type: "element",
        tagName: "span",
        properties: {
          className: [BLOCKED_IMAGE_FRAME_CLASS],
          "data-docwalk-label": m.render_load_image({ host }),
          ...(alt ? { "data-docwalk-alt": alt } : {}),
        },
        children: [node],
      };
      return SKIP;
    });
  };
}

/** Class on the empty `<span>` that stands where a task item's checkbox was (decision 86). */
export const TASK_BOX_CLASS = "docwalk-task-box";

/** What a task mark is told to the viewer, by state. `data-state` carries the same value for CSS. */
const TASK_LABELS = { done: m.render_task_done, open: m.render_task_open };

/** A value nothing in a document can guess, for one render: placeholders without it are not ours. */
function taskNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Before the sanitizers: remark-rehype turns a GFM task item into
 * `<li class="task-list-item"><input type="checkbox" checked disabled>`, and
 * no `<input>` may reach the page. Each one becomes an empty placeholder that
 * names the item's state with this render's nonce. Only the Markdown tree
 * has produced elements at this point (raw HTML is still text), so every
 * `<input>` here is a task item's.
 */
function rehypeMarkTasks(nonce: string) {
  return () => (tree: HastRoot) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "input" || !parent || index === undefined) return;
      const state = node.properties["checked"] ? "done" : "open";
      parent.children[index] = {
        type: "element",
        tagName: "span",
        properties: { dataDocwalkTask: `${nonce}:${state}` },
        children: [],
      };
      return SKIP;
    });
  };
}

/**
 * After the sanitizers: a placeholder with this render's nonce becomes the
 * mark, a read-only drawing and not a form control (decision 86); one
 * without it, which only a document can have written, loses the attribute and
 * stays a plain span. Like the alerts of decision 25, the markup is ours, so
 * the schema needs no class, role or label that raw HTML could then forge.
 */
function rehypeDrawTasks(nonce: string) {
  return () => (tree: HastRoot) => {
    visit(tree, "element", (node: Element) => {
      const value = node.properties["dataDocwalkTask"];
      if (value === undefined) return;
      delete node.properties["dataDocwalkTask"];
      const state = value === `${nonce}:done` ? "done" : value === `${nonce}:open` ? "open" : null;
      if (node.tagName !== "span" || !state) return;
      node.properties["className"] = [TASK_BOX_CLASS];
      node.properties["dataState"] = state;
      node.properties["role"] = "img";
      node.properties["ariaLabel"] = TASK_LABELS[state]();
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
 *    which also prefixes ids with `user-content-`, then re-parsed until
 *    stable when the input had raw HTML (`rehypeSettle`);
 * 4. rehype-github-alert turns `> [!NOTE]` quotes into alerts. It runs after
 *    the sanitizer (decision 25), so the alert markup it adds is ours and the
 *    schema needs no class or SVG allowances that raw HTML could then forge;
 * 5. the remote image gate (decision 33);
 * 6. task list marks: the checkbox remark-rehype writes is replaced before
 *    the sanitizers and drawn after them (decision 86).
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
  let hasRawHtml = false;
  visit(root, "html", () => {
    hasRawHtml = true;
    return false;
  });
  const nonce = taskNonce();
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
      .use(rehypeMarkTasks(nonce))
      .use(rawHtml)
      .use(rehypePrefixFootnoteLabel, footnotePrefix)
      .use(rehypeSanitize, SANITIZE_SCHEMA)
      // Markdown alone builds a tree the parser would build too; raw HTML may not.
      // unified's on/off switch: `false` leaves the plugin out.
      .use(rehypeSettle, rawHtml === rehypeRaw && hasRawHtml)
      .use(rehypeDrawTasks(nonce))
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
