import { parseUnicodeRange, rangeCoversText } from "./cssText";

/**
 * The app's own CSS, read back from the CSSOM so an export looks like the
 * deck. Only same-origin sheets are read (cross-origin ones throw on
 * `cssRules`, and docwalk loads none: fonts are self-hosted, decision 51).
 * Every `url()` is resolved against its sheet and then kept or dropped by a
 * policy, so an export never carries a reference the caller did not allow.
 */

interface SheetRule {
  /** The rule's text, wrapped in its sheet's media query when it has one. */
  cssText: string;
  /** The URL relative `url()`s in the rule resolve against. */
  base: string;
  /** `@font-face` rules are handled separately: inlined or dropped. */
  fontFace: { src: string; unicodeRange: string; declarations: string[] } | null;
}

export function sameOriginRules(doc: Document = document): SheetRule[] {
  const origin = new URL(doc.baseURI).origin;
  const out: SheetRule[] = [];
  const visit = (sheet: CSSStyleSheet, media: string) => {
    if (sheet.disabled) return;
    if (sheet.href && new URL(sheet.href, doc.baseURI).origin !== origin) return;
    const base = sheet.href ?? doc.baseURI;
    const own = sheet.media.mediaText;
    const wrap = own && own !== "all" ? own : media;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return;
    }
    for (const rule of rules) {
      if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) visit(rule.styleSheet, rule.media.mediaText || wrap);
        continue;
      }
      const cssText = wrap ? `@media ${wrap} { ${rule.cssText} }` : rule.cssText;
      out.push({
        cssText,
        base,
        fontFace: rule instanceof CSSFontFaceRule ? fontFace(rule) : null,
      });
    }
  };
  for (const sheet of doc.styleSheets) visit(sheet, "");
  for (const sheet of doc.adoptedStyleSheets) visit(sheet, "");
  return out;
}

function fontFace(rule: CSSFontFaceRule): SheetRule["fontFace"] {
  const declarations: string[] = [];
  for (const name of rule.style) {
    if (name === "src") continue;
    declarations.push(`${name}: ${rule.style.getPropertyValue(name)};`);
  }
  return {
    src: rule.style.getPropertyValue("src"),
    unicodeRange: rule.style.getPropertyValue("unicode-range"),
    declarations,
  };
}

interface InlinedFonts {
  /** `@font-face` rules with `data:` sources, or "" when fonts were not embedded. */
  css: string;
  /** A CSS comment saying what happened, for the reader of an exported file. */
  note: string;
}

/** Font file signatures: WOFF2, WOFF, OpenType (CFF), TrueType. */
const FONT_MAGIC: Record<string, string> = {
  wOF2: "font/woff2",
  wOFF: "font/woff",
  OTTO: "font/otf",
  "\u0000\u0001\u0000\u0000": "font/ttf",
};

/**
 * Embed the self-hosted fonts a set of slides needs as `data:` URLs.
 * Only faces whose `unicode-range` covers a character in `text` are taken
 * (the subsets the browser itself would load), only from the app's own
 * origin, and only when the bytes are really a font: a static host answers
 * a missing file with its HTML fallback and a 200. When the total passes
 * `budget` bytes nothing is embedded and the system font stack applies.
 */
export async function inlineFonts(
  rules: SheetRule[],
  text: string,
  budget: number,
  origin: string = location.origin,
): Promise<InlinedFonts> {
  const faces: string[] = [];
  let bytes = 0;
  let failed = 0;
  for (const { fontFace: face, base } of rules) {
    if (!face || !rangeCoversText(parseUnicodeRange(face.unicodeRange), text)) continue;
    const first = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)\s*(format\([^)]*\))?/i.exec(
      face.src,
    );
    if (!first) continue;
    const raw = (first[1] ?? first[2] ?? first[3] ?? "").trim();
    let dataUrl: string | null = null;
    if (/^data:font\//i.test(raw)) {
      dataUrl = raw;
      bytes += raw.length;
    } else {
      const url = safeUrl(raw, base);
      if (!url || url.origin !== origin) {
        failed++;
        continue;
      }
      const font = await fetchFont(url);
      if (!font) {
        failed++;
        continue;
      }
      bytes += font.size;
      if (bytes > budget) {
        return {
          css: "",
          note: `/* Fonts are not embedded: they total more than ${formatBytes(budget)}. The system font stack applies. */`,
        };
      }
      dataUrl = await blobToDataUrl(font);
    }
    faces.push(
      `@font-face { src: url("${dataUrl}") ${first[4] ?? ""}; ${face.declarations.join(" ")} }`,
    );
  }
  if (faces.length === 0) {
    return {
      css: "",
      note: "/* No self-hosted fonts were found to embed. The system font stack applies. */",
    };
  }
  const skipped =
    failed > 0
      ? ` ${failed} face(s) could not be read and fall back to the system font stack.`
      : "";
  return {
    css: faces.join("\n"),
    note: `/* Fonts embedded as data: URLs (${formatBytes(bytes)}).${skipped} */`,
  };
}

function safeUrl(raw: string, base: string): URL | null {
  if (raw === "") return null;
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

async function fetchFont(url: URL): Promise<Blob | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const magic = String.fromCharCode(...new Uint8Array(buffer.slice(0, 4)));
    const type = FONT_MAGIC[magic];
    return type ? new Blob([buffer], { type }) : null;
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read font")),
    );
    reader.readAsDataURL(blob);
  });
}

function formatBytes(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.ceil(n / 1000)} KB`;
}
