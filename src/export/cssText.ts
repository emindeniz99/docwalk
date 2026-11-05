/**
 * Pure CSS text helpers, shared by the exporters and testable in Node.
 */

const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

/**
 * Resolve every `url()` in `cssText` against `base`; keep it (absolute) when
 * `keep` allows the URL, otherwise replace it with `none`, which turns the
 * declaration invalid or empty instead of fetching. `data:` URLs and local
 * fragments (`url(#arrow)`, used by SVG markers) never fetch and stay.
 */
export function rewriteCssUrls(cssText: string, base: string, keep: (url: URL) => boolean): string {
  return cssText.replace(URL_TOKEN, (match, dq?: string, sq?: string, bare?: string) => {
    const raw = (dq ?? sq ?? bare ?? "").trim();
    if (/^data:/i.test(raw) || raw.startsWith("#")) return match;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      return "none";
    }
    return raw !== "" && keep(url) ? `url("${url.href}")` : "none";
  });
}

/** CSS text that is safe inside a `<style>` element: `<` cannot start `</style>`. */
export function escapeStyleText(css: string): string {
  return css.replace(/</g, "\\3c ");
}

/** `unicode-range` as inclusive code point ranges. An empty list means "every code point". */
export function parseUnicodeRange(value: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of value.split(",")) {
    const m = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) continue;
    const start = m[1] ?? "";
    if (start.includes("?")) {
      out.push([
        parseInt(start.replaceAll("?", "0"), 16),
        parseInt(start.replaceAll("?", "f"), 16),
      ]);
    } else {
      const s = parseInt(start, 16);
      out.push([s, m[2] ? parseInt(m[2], 16) : s]);
    }
  }
  return out;
}

export function rangeCoversText(ranges: [number, number][], text: string): boolean {
  if (ranges.length === 0) return true;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ranges.some(([a, b]) => cp >= a && cp <= b)) return true;
  }
  return false;
}
