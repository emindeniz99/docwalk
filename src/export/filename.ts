/**
 * File names for exports. A slide address is `<section-id>/<page>`
 * (decision 21); section ids come from the document's headings, so they may
 * hold any letter. Letters and digits survive in every script, everything
 * else (slashes, dots, quotes, characters Windows forbids) becomes a dash.
 */

const MAX_SLUG = 60;

export function slugify(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
}

/**
 * `<index>-<address-slug>.png`, the index 1-based and zero-padded to the
 * width of the slide count, so a file browser lists the slides in deck order.
 */
export function slideFileName(index: number, total: number, address: string): string {
  const width = String(Math.max(total, index)).length;
  const slug = slugify(address) || "slide";
  return `${String(index).padStart(width, "0")}-${slug}.png`;
}

export function htmlFileName(title: string): string {
  return `${slugify(title) || "docwalk"}.html`;
}
