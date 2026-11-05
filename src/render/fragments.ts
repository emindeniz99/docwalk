/**
 * What hast-util-sanitize's GitHub schema puts before every content `id` and
 * `name`, as GitHub does, so content cannot clobber page globals.
 */
export const CLOBBER_PREFIX = "user-content-";

/**
 * Same-page links (`#retry-budget`, `#fn-a`) the way GitHub resolves them.
 * The sanitizer prefixes every content id and name with `user-content-`, so
 * the link and its target never match by name alone; GitHub's page script
 * bridges that, and these helpers do the same for slides and document mode.
 */

function decoded(fragment: string): string | null {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return null;
  }
}

/** The element in `root` whose prefixed id or name is `user-content-<anchor>`. */
export function anchorTarget(root: ParentNode, anchor: string): HTMLElement | null {
  if (!anchor) return null;
  const name = CSS.escape(`${CLOBBER_PREFIX}${anchor}`);
  return root.querySelector<HTMLElement>(`[id="${name}"], a[name="${name}"]`);
}

/**
 * Where a `#…` link points inside `root`: the GitHub-prefixed target first,
 * then an exact id (a link written with the prefix already in it). Tried
 * with the fragment as written and percent-decoded, because footnote ids
 * keep their encoding (`fn-%C3%A9`) while heading ids are plain text.
 */
export function fragmentTarget(root: ParentNode, href: string): HTMLElement | null {
  if (!href.startsWith("#")) return null;
  const raw = href.slice(1);
  const forms = [...new Set([raw, decoded(raw)])].filter((f): f is string => !!f);
  for (const form of forms) {
    const target = anchorTarget(root, form);
    if (target) return target;
  }
  for (const form of forms) {
    const target = root.querySelector<HTMLElement>(`[id="${CSS.escape(form)}"]`);
    if (target) return target;
  }
  return null;
}

/** The fragment of a `#…` link as an address the deck understands, or null when it does not decode. */
export function fragmentAddress(href: string): string | null {
  return href.startsWith("#") ? decoded(href.slice(1)) : null;
}

/**
 * Moves focus to a link's target, as following the link would, without the
 * browser's own scroll: inside a slide that scroll would move reveal.js's
 * stage, so only the slide body (its own scroll box) is scrolled.
 */
export function focusTarget(target: HTMLElement): void {
  if (!target.hasAttribute("tabindex") && target.tabIndex < 0) target.tabIndex = -1;
  const box = target.closest<HTMLElement>(".docwalk-slide-body");
  if (box) {
    // reveal.js scales the stage, so client rects are scaled; scrollTop is not.
    const scale = box.getBoundingClientRect().height / (box.offsetHeight || 1) || 1;
    const t = target.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (t.top < b.top || t.bottom > b.bottom) box.scrollTop += (t.top - b.top) / scale;
  } else {
    target.scrollIntoView({ block: "start" });
  }
  target.focus({ preventScroll: true });
}
