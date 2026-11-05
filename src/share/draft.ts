/**
 * Draft autosave (decision 7). A pasted or dropped document exists nowhere
 * else, so it is saved to localStorage while the user types; a URL, repo,
 * sample or share-fragment document can be loaded again and is not saved.
 * The record holds the Markdown and the source kind only: never a token
 * (tokens live in sessionStorage, decision 35). Storage can be missing,
 * blocked or full, and what it returns is untrusted (decision 46), so every
 * access is caught and every read is validated.
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

/** Saves now. Returns false when the draft could not be stored (unavailable or full). */
export function saveDraft(markdown: string, source: DraftSource): boolean {
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
    globalThis.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      globalThis.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [markdown, kind, name]);
}
