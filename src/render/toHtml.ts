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

/**
 * Remote images leak the viewer's IP address to the image host, and docwalk
 * has no proxy. So the sanitizer is the gate (decision 33): it moves a
 * remote `src` to `data-src`, and the page loads it only after a click or
 * when the setting allows it. Relative, `data:` and `blob:` sources pass.
 */
export function rehypeBlockRemoteImages(options: HtmlOptions = {}) {
  return (tree: HastRoot) => {
    if (options.loadRemoteImages) return;
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "img") return;
      const src = node.properties["src"];
      if (typeof src !== "string" || !/^https?:/i.test(src)) return;
      node.properties["dataSrc"] = src;
      delete node.properties["src"];
      const classes = Array.isArray(node.properties["className"])
        ? node.properties["className"]
        : [];
      node.properties["className"] = [...classes, BLOCKED_IMAGE_CLASS];
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
