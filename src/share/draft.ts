/**
 * Draft autosave (decision 7). A pasted or dropped document exists nowhere
 * else, so it is saved to localStorage while the user types; a URL, repo,
 * sample or share-fragment document can be loaded again and is not saved.
 * The record holds the Markdown and the source kind only: never a token
 * (tokens live in sessionStorage, decision 35). Storage can be missing,
 * blocked or full, and what it returns is untrusted (decision 46), so every
 * access is caught and every read is validated.
 *
 * There is one draft slot, and an edited share-link, URL or repo document
 * becomes the user's own text too. So the slot is written only by a page
 * that holds it: one that opened the draft, opened a file, found the slot
 * empty, or was told by the user to replace it. Anything else would let a
 * typo fixed in a colleague's link silently destroy the only copy of a
 * pasted document.
 */
import { useEffect } from "react";
import * as v from "valibot";
import type { DocumentSource, LoadedDocument } from "../inputs/types";
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import { DRAFT_STORAGE_KEY } from "./types";

export const DRAFT_DEBOUNCE_MS = 800;

type DraftSource = Extract<DocumentSource, { kind: "paste" | "file" }>;

const DraftSchema = v.object({
  markdown: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_DOCUMENT_BYTES)),
  source: v.variant("kind", [
    v.object({ kind: v.literal("paste") }),
    v.object({ kind: v.literal("file"), name: v.pipe(v.string(), v.maxLength(255)) }),
  ]),
});

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let held = false;
/** Saves the edits the autosave is still waiting to write, if any. */
let pendingFlush: (() => void) | null = null;

/** This page's document is the draft now (the draft was opened, a file was opened, or the user chose to replace it). */
export function holdDraft(): void {
  held = true;
}

/** True while this page's document is the draft (opened, saved into an empty slot, or chosen by the user). */
export function draftHeld(): boolean {
  return held;
}

/**
 * Writes the edits still waiting for the autosave's debounce now. A caller
 * about to replace the document calls this first: once the draft is released
 * the write would be refused, and the last keystrokes would be lost.
 */
export function flushDraft(): void {
  pendingFlush?.();
}

/**
 * This page's document is no longer the draft: a share link, URL, repo or
 * workspace document replaced it. Edits still waiting to be saved are saved
 * first, while the page still holds the slot.
 */
export function releaseDraft(): void {
  flushDraft();
  held = false;
}

/** True when saving now would replace a draft this page does not hold. */
export function draftWouldBeReplaced(): boolean {
  return !held && loadDraft() !== null;
}

/** The saved draft, or `null` when there is none, storage is unavailable, or the record is damaged. */
export function loadDraft(): LoadedDocument | null {
  let raw: string | null;
  try {
    raw = storage()?.getItem(DRAFT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = v.safeParse(DraftSchema, parsed);
  return result.success ? result.output : null;
}

export function clearDraft(): void {
  try {
    storage()?.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/**
 * Saves now. Returns false when the draft could not be stored (unavailable or
 * full) or when it would replace a draft this page does not hold.
 */
export function saveDraft(markdown: string, source: DraftSource): boolean {
  if (draftWouldBeReplaced()) return false;
  held = true;
  if (markdown.trim() === "") {
    clearDraft();
    return true;
  }
  // Build the record field by field, so nothing else on `source` is stored.
  const record = {
    markdown,
    source: source.kind === "file" ? { kind: "file", name: source.name } : { kind: "paste" },
  };
  try {
    const store = storage();
    if (store === null) return false;
    store.setItem(DRAFT_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves the document about `DRAFT_DEBOUNCE_MS` after the last edit, and at
 * once when the page is hidden or closed, so the last keystrokes survive.
 */
export function useDraftAutosave(markdown: string, source: DocumentSource): void {
  const kind = source.kind;
  const name = source.kind === "file" ? source.name : null;
  useEffect(() => {
    if (kind !== "paste" && kind !== "file") return;
    const draftSource: DraftSource = kind === "file" ? { kind, name: name ?? "" } : { kind };
    let pending = true;
    const flush = () => {
      if (!pending) return;
      pending = false;
      saveDraft(markdown, draftSource);
    };
    // Mobile browsers often discard a backgrounded tab without `pagehide`;
    // `visibilitychange` to hidden is the last event they reliably fire.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const timer = setTimeout(flush, DRAFT_DEBOUNCE_MS);
    pendingFlush = flush;
    globalThis.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      // A newer edit re-runs this effect and takes over the pending save; a
      // replaced document has had it flushed by releaseDraft already.
      if (pendingFlush === flush) pendingFlush = null;
      clearTimeout(timer);
      globalThis.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [markdown, kind, name]);
}
