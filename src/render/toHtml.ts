import type { Element, Root as HastRoot } from "hast";
import type { Root, RootContent } from "mdast";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/** Class on an image whose remote `src` was moved to `data-src` until the viewer allows it. */
export const BLOCKED_IMAGE_CLASS = "docwalk-blocked-image";

export interface HtmlOptions {
  /** Load remote images directly (the "always load images" setting). Default: blocked. */
  loadRemoteImages?: boolean;
}

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
      const host = URL.canParse(remote) ? new URL(remote).host : "another site";
      const label = `Load image${alt ? ` "${alt}"` : ""} from ${host}`;
      node.properties["role"] = "button";
      node.properties["tabIndex"] = 0;
      node.properties["ariaLabel"] = label;
      node.properties["title"] = label;
    });
  };
}

/**
 * Render mdast nodes to HTML the way GitHub would, then sanitize with
 * hast-util-sanitize's default schema, which follows GitHub's rules
 * (including the `user-content-` prefix on ids). Raw HTML in the source is
 * kept only as far as that schema allows. DOMPurify runs again in the
 * browser before insertion (see `src/deck/purify.ts`).
 */
export function nodesToHtml(nodes: RootContent[], options: HtmlOptions = {}): string {
  const root: Root = { type: "root", children: nodes };
  const processor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRawPassthrough)
    .use(rehypeSanitize, defaultSchema)
    .use(rehypeBlockRemoteImages, options)
    .use(rehypeStringify);
  const hast = processor.runSync(root);
  return processor.stringify(hast as HastRoot);
}

/**
 * remark-rehype keeps raw HTML as `raw` nodes when `allowDangerousHtml` is
 * set. Parsing them into elements needs rehype-raw (not added yet), so for
 * now raw nodes are dropped: the safe choice until raw HTML support lands.
 */
function rehypeRawPassthrough() {
  return (tree: HastRoot) => {
    visit(tree, "raw", (_node, index, parent) => {
      if (parent && typeof index === "number") {
        parent.children.splice(index, 1);
        return index;
      }
      return undefined;
    });
  };
}
