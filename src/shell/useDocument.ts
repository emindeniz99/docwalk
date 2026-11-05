import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import sample from "../../fixtures/ledger-redesign.md?raw";
import {
  describeLoadError,
  loadFromFile,
  loadFromRepo,
  loadFromUrl,
  parseInputUrl,
  type InputRequest,
} from "../inputs/load";
import { readRefresh, readToken } from "../inputs/token";
import type { LoadedDocument, LoadResult } from "../inputs/types";
import {
  draftWouldBeReplaced,
  holdDraft,
  loadDraft,
  releaseDraft,
  saveDraft,
} from "../share/draft";
import { isDocHash, readFragment } from "../share/fragment";
import { rememberedFile } from "../workspace/store";

export const SAMPLE: LoadedDocument = { markdown: sample, source: { kind: "sample" } };

export const DAMAGED_LINK = "This share link is damaged or incomplete.";

export const DRAFT_KEPT =
  "Your edits are not saved in this browser: saving them would replace the draft you saved earlier.";

export interface Notice {
  message: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

type RepoRequest = Extract<InputRequest, { kind: "repo" }>;

/**
 * The document on first render, when it can be known without waiting:
 * the saved draft or the sample. `null` while something must load first:
 * an OAuth callback (which restores the page the user signed in from), a
 * `?src=` / `?repo=` link, a `#doc=` share link, a workspace file to reopen,
 * or a follower waiting for the presenter's link.
 */
function initialDocument(follow: boolean): LoadedDocument | null {
  if (follow) return null;
  const url = new URL(location.href);
  if (url.searchParams.get("oauth") === "callback") return null;
  if (parseInputUrl(url) !== null || isDocHash(url.hash)) return null;
  // Only a browser that has opened a workspace file waits here; everyone else starts as before.
  if (rememberedFile() !== null) return null;
  return openDraft() ?? SAMPLE;
}

/** The saved draft, which this page then holds (src/share/draft.ts). */
function openDraft(): LoadedDocument | null {
  const draft = loadDraft();
  if (draft) holdDraft();
  return draft;
}

/**
 * Where the document comes from (decisions 5, 6, 7): startup loading in the
 * order the notes fix (OAuth callback first, then `?src=`, `?repo=`,
 * `#doc=`, then the workspace file shown last, then the draft), the untrusted-host confirmation, the token retry
 * for private repositories, and edits. A URL-loaded document is never
 * replaced by a draft; a failed load falls back to the sample, never to a
 * draft the user did not ask for. The newest load the user started wins: a
 * slower one started earlier is dropped when it resolves.
 */
export function useDocument({ follow }: { follow: boolean }) {
  const [doc, setDoc] = useState<LoadedDocument | null>(() => initialDocument(follow));
  const [confirm, setConfirm] = useState<{ url: string; host: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  /** The repository load that failed for lack of access; a saved token retries it. */
  const retryRepo = useRef<RepoRequest | null>(null);
  /** Bumped by every load; a load whose number is no longer current has been overtaken. */
  const generation = useRef(0);
  const docRef = useRef(doc);
  useLayoutEffect(() => {
    docRef.current = doc;
  });

  const applyResult = useCallback((result: LoadResult, repo: RepoRequest | null = null) => {
    if (result.ok) {
      retryRepo.current = null;
      setConfirm(null);
      setNotice(null);
      // An opened file has a copy on disk and becomes the draft, as before;
      // any other loaded document leaves the saved draft alone.
      if (result.doc.source.kind === "file") holdDraft();
      else releaseDraft();
      setDoc(result.doc);
      return;
    }
    setDoc((prev) => prev ?? SAMPLE);
    const { error } = result;
    if (error.kind === "needs-confirmation") {
      setConfirm({ url: error.url, host: error.host });
      return;
    }
    const privateRepo =
      repo !== null && (error.kind === "unauthorized" || error.kind === "not-found");
    retryRepo.current = privateRepo ? repo : null;
    setNotice({
      message: describeLoadError(error),
      tone: "error",
      ...(privateRepo
        ? { action: { label: "Add a GitHub token", run: () => setTokenOpen(true) } }
        : {}),
    });
  }, []);

  /** Applies a result the user already has (the Open file button), overtaking any load still running. */
  const apply = useCallback(
    (result: LoadResult, repo: RepoRequest | null = null) => {
      generation.current++;
      applyResult(result, repo);
    },
    [applyResult],
  );

  const loadRequest = useCallback(
    async (request: InputRequest) => {
      const gen = ++generation.current;
      if (request.kind === "url") {
        const result = await loadFromUrl(request.url);
        if (gen === generation.current) applyResult(result);
      } else {
        const result = await loadFromRepo({ ...request, token: readToken() });
        if (gen === generation.current) applyResult(result, request);
      }
    },
    [applyResult],
  );

  const loadFragment = useCallback(async (hash: string) => {
    const gen = ++generation.current;
    const markdown = await readFragment(hash);
    if (gen !== generation.current) return;
    if (markdown !== null) {
      releaseDraft();
      setDoc({ markdown, source: { kind: "fragment" } });
    } else {
      setDoc((prev) => prev ?? SAMPLE);
      setNotice({ message: DAMAGED_LINK, tone: "error" });
    }
  }, []);

  // Start-up runs once per page. A ref, not an abort on cleanup: StrictMode's
  // rehearsal unmount would otherwise cancel the only load. App is the root
  // and lives as long as the page, so the refresh timer needs no stop.
  const started = useRef(false);
  useEffect(() => {
    if (follow || started.current) return;
    started.current = true;
    const startedAt = generation.current;
    const signedOut = () => setNotice({ message: "Signed out of GitHub.", tone: "info" });
    void (async () => {
      // OAuth code loads only for a sign-in callback or a session to keep fresh.
      const callback = new URL(location.href).searchParams.get("oauth") === "callback";
      if (callback || readRefresh() !== null) {
        const { completeLogin, scheduleRefresh } = await import("../inputs/oauth");
        // The callback replaces the URL with the page the user signed in from,
        // so the document parameters are read only after it resolves.
        const login = await completeLogin(location.href, {}, signedOut);
        if (login.kind === "error") setNotice({ message: login.message, tone: "error" });
        if (login.kind === "signed-in") {
          setNotice({ message: "Signed in to GitHub.", tone: "info" });
        } else {
          scheduleRefresh({}, signedOut);
        }
      }

      // A document the user opened during the sign-in wait stays.
      if (generation.current !== startedAt) return;
      const request = parseInputUrl(location.href);
      if (request?.kind === "invalid") {
        setDoc((prev) => prev ?? SAMPLE);
        setNotice({ message: request.message, tone: "error" });
      } else if (request) {
        await loadRequest(request);
      } else if (isDocHash(location.hash)) {
        await loadFragment(location.hash);
      } else {
        // A workspace file shown on the last visit comes back (decision 57); a
        // link always wins over it, and it wins over the draft.
        const remembered = docRef.current ? null : rememberedFile();
        if (remembered) {
          const { restoreFile } = await import("../workspace/restore");
          const restored = await restoreFile(remembered);
          if (generation.current !== startedAt) return;
          if (restored) {
            releaseDraft();
            setDoc(restored);
            return;
          }
        }
        const draft = docRef.current ? null : openDraft();
        setDoc((prev) => prev ?? draft ?? SAMPLE);
      }
    })();
  }, [follow, loadRequest, loadFragment]);

  // A share link pasted into this tab's address bar changes only the hash, so
  // the page does not reload: load the shared document here.
  useEffect(() => {
    if (follow) return;
    const onHashChange = () => {
      if (isDocHash(location.hash)) void loadFragment(location.hash);
    };
    globalThis.addEventListener("hashchange", onHashChange);
    return () => globalThis.removeEventListener("hashchange", onHashChange);
  }, [follow, loadFragment]);

  /**
   * A follower loads the presenter's share link in place: only its `?src=`,
   * `?repo=` and `#doc=` parts, never a navigation, so the `#room=` fragment
   * stays and no other parameter of the link can act on this page.
   */
  const loadFromLink = useCallback(
    async (link: string) => {
      const request = parseInputUrl(link);
      if (request?.kind === "invalid") {
        setNotice({ message: request.message, tone: "error" });
      } else if (request) {
        await loadRequest(request);
      } else if (isDocHash(new URL(link).hash)) {
        await loadFragment(new URL(link).hash);
      } else {
        setNotice({ message: "The presenter's link names no document.", tone: "error" });
      }
    },
    [loadRequest, loadFragment],
  );

  const confirmLoad = useCallback(async () => {
    if (!confirm) return;
    setConfirm(null);
    const gen = ++generation.current;
    const result = await loadFromUrl(confirm.url, { confirmed: true });
    if (gen === generation.current) applyResult(result);
  }, [confirm, applyResult]);

  const openFile = useCallback(
    async (file: File) => {
      const gen = ++generation.current;
      const result = await loadFromFile(file);
      if (gen === generation.current) applyResult(result);
    },
    [applyResult],
  );

  /** "Replace my draft": the user chose to make this document the saved draft. */
  const replaceDraft = useCallback(() => {
    const current = docRef.current;
    holdDraft();
    if (current && (current.source.kind === "paste" || current.source.kind === "file")) {
      saveDraft(current.markdown, current.source);
    }
    setNotice(null);
  }, []);

  /**
   * An edit makes the document the user's own text: it is autosaved and
   * shares as a fragment. Editing a share-link, URL, repo or sample document
   * never replaces a saved draft on its own: the user is asked first.
   */
  const edit = useCallback(
    (markdown: string) => {
      const before = docRef.current?.source.kind;
      // A workspace file is saved by the workspace (src/workspace), never into the draft slot.
      if (before === "workspace") {
        setDoc((prev) => ({ markdown, source: prev?.source ?? { kind: "paste" } }));
        return;
      }
      const own = before === "paste" || before === "file";
      if (!own && draftWouldBeReplaced()) {
        setNotice({
          message: DRAFT_KEPT,
          tone: "info",
          action: { label: "Replace my draft", run: replaceDraft },
        });
      }
      setDoc((prev) => ({
        markdown,
        source:
          prev && (prev.source.kind === "paste" || prev.source.kind === "file")
            ? prev.source
            : { kind: "paste" },
      }));
    },
    [replaceDraft],
  );

  /** After "Save token" in the dialog: retry the repository load that was refused. */
  const tokenChanged = useCallback(
    (token: string | null) => {
      const repo = retryRepo.current;
      if (!token || !repo) return;
      const gen = ++generation.current;
      void loadFromRepo({ ...repo, token }).then((r) => {
        if (gen === generation.current) applyResult(r, repo);
      });
    },
    [applyResult],
  );

  /** Shows a document the workspace read (decision 57), overtaking any load still running. */
  const openDocument = useCallback((next: LoadedDocument) => {
    generation.current++;
    setConfirm(null);
    setNotice(null);
    releaseDraft();
    setDoc(next);
  }, []);

  /** The open workspace file was deleted: show the draft or the sample, as a plain visit would. */
  const closeDocument = useCallback(() => {
    generation.current++;
    setDoc(openDraft() ?? SAMPLE);
  }, []);

  /** The open workspace file was renamed or moved: same text, new address. */
  const retarget = useCallback((source: LoadedDocument["source"]) => {
    setDoc((prev) => (prev ? { markdown: prev.markdown, source } : prev));
  }, []);

  return {
    doc,
    openDocument,
    closeDocument,
    retarget,
    confirm,
    confirmLoad,
    cancelConfirm: () => setConfirm(null),
    notice,
    setNotice,
    tokenOpen,
    setTokenOpen,
    tokenChanged,
    apply,
    openFile,
    edit,
    loadFromLink,
  };
}
