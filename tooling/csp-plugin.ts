import type { Plugin } from "vite";
import { CONTENT_SECURITY_POLICY } from "../worker/csp.ts";

/**
 * The policy as a `<meta>` tag can carry it. Browsers ignore
 * `frame-ancestors` in a meta CSP (and warn about it), so it is dropped;
 * framing protection exists only where the host sends the real header.
 */
export function metaContentSecurityPolicy(policy: string = CONTENT_SECURITY_POLICY): string {
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "" && !directive.startsWith("frame-ancestors"))
    .join("; ");
}

/**
 * Static mode has no `_headers` support on most hosts (GitHub Pages ignores
 * it), so the built `index.html` carries the same CSP as a `<meta>` tag
 * (decision 34). Build only: the dev server injects an inline React Refresh
 * preamble that `script-src 'self'` would block.
 */
export function docwalkCspMeta(): Plugin {
  return {
    name: "docwalk-csp-meta",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => withCspMeta(html),
    },
  };
}

/**
 * Inserts the tag right after `<meta charset>`: ahead of every script and
 * stylesheet, since a meta CSP governs only what the parser meets after it,
 * while the charset stays first.
 */
export function withCspMeta(html: string): string {
  const charset = /<meta charset="[^"]*"\s*\/?>/i.exec(html);
  if (!charset) throw new Error("index.html needs <meta charset> before the CSP can follow it");
  const content = metaContentSecurityPolicy().replaceAll("'", "&#39;");
  const tag = `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
  const end = charset.index + charset[0].length;
  return `${html.slice(0, end)}\n    ${tag}${html.slice(end)}`;
}
