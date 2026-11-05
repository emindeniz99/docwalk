import { tokens } from "./tokens.ts";

const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * The tokens as CSS custom properties, emitted at build time (no runtime
 * style injection). Names: --dw-color-<name>, --dw-radius-<level>,
 * --dw-space-<level>, --dw-type-<name>-{family,size,weight,line-height,letter-spacing}.
 * src/styles.css maps these onto semantic, theme-aware variables.
 */
export function tokensToCss(t: typeof tokens = tokens): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(t.colors)) lines.push(`--dw-color-${name}: ${value};`);
  for (const [name, value] of Object.entries(t.rounded))
    lines.push(`--dw-radius-${name}: ${value};`);
  for (const [name, value] of Object.entries(t.spacing))
    lines.push(`--dw-space-${name}: ${value};`);
  for (const [name, style] of Object.entries(t.typography)) {
    const s = style as Record<string, string | number>;
    const fallback = String(s["fontFamily"]).includes("Mono") ? MONO_FALLBACK : SANS_FALLBACK;
    lines.push(`--dw-type-${name}-family: "${s["fontFamily"]}", ${fallback};`);
    lines.push(`--dw-type-${name}-size: ${s["fontSize"]};`);
    lines.push(`--dw-type-${name}-weight: ${s["fontWeight"]};`);
    if (s["lineHeight"] !== undefined)
      lines.push(`--dw-type-${name}-line-height: ${s["lineHeight"]};`);
    if (s["letterSpacing"] !== undefined)
      lines.push(`--dw-type-${name}-letter-spacing: ${s["letterSpacing"]};`);
  }
  return `:root {\n  ${lines.join("\n  ")}\n}\n`;
}
