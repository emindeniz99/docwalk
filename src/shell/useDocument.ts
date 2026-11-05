import { useCallback, useEffect, useRef, useState } from "react";
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
import { loadDraft } from "../share/draft";
import { isDocHash, readFragment } from "../share/fragment";

export const SAMPLE: LoadedDocument = { markdown: sample, source: { kind: "sample" } };

export const DAMAGED_LINK = "This share link is damaged or incomplete.";

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
 * `?src=` / `?repo=` link, a `#doc=` share link, or a follower waiting for
 * the presenter's link.
 */
function initialDocument(follow: boolean): LoadedDocument | null {
  if (follow) return null;
  const url = new URL(location.href);
  if (url.searchParams.get("oauth") === "callback") return null;
  if (parseInputUrl(url) !== null || isDocHash(url.hash)) return null;
  return loadDraft() ?? SAMPLE;
}

/**
 * Where the document comes from (decisions 5, 6, 7): startup loading in the
 * order the notes fix (OAuth callback first, then `?src=`, `?repo=`,
 * `#doc=`, then the draft), the untrusted-host confirmation, the token retry
 * for private repositories, and edits. A URL-loaded document is never
 * replaced by a draft; a failed load falls back to the sample, never to a
 * draft the user did not ask for.
 */
export function useDocument({ follow }: { follow: boolean }) {
  const [doc, setDoc] = useState<LoadedDocument | null>(() => initialDocument(follow));
  const [confirm, setConfirm] = useState<{ url: string; host: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  /** The repository load that failed for lack of access; a saved token retries it. */
  const retryRepo = useRef<RepoRequest | null>(null);

  const apply = useCallback((result: LoadResult, repo: RepoRequest | null = null) => {
    if (result.ok) {
      retryRepo.current = null;
      setConfirm(null);
      setNotice(null);
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

  const loadRequest = useCallback(
    async (request: InputRequest) => {
      if (request.kind === "url") apply(await loadFromUrl(request.url));
      else apply(await loadFromRepo({ ...request, token: readToken() }), request);
    },
    [apply],
  );

  const loadFragment = useCallback(async (hash: string) => {
    const markdown = await readFragment(hash);
    if (markdown !== null) {
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

      const request = parseInputUrl(location.href);
      if (request?.kind === "invalid") {
        setDoc((prev) => prev ?? SAMPLE);
        setNotice({ message: request.message, tone: "error" });
      } else if (request) {
        await loadRequest(request);
      } else if (isDocHash(location.hash)) {
        await loadFragment(location.hash);
      } else {
        setDoc((prev) => prev ?? loadDraft() ?? SAMPLE);
      }
    })();
  }, [follow, loadRequest, loadFragment]);

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
    apply(await loadFromUrl(confirm.url, { confirmed: true }));
  }, [confirm, apply]);

  const openFile = useCallback(async (file: File) => apply(await loadFromFile(file)), [apply]);

  /** An edit makes the document the user's own text: it is autosaved and shares as a fragment. */
  const edit = useCallback((markdown: string) => {
    setDoc((prev) => ({
      markdown,
      source:
        prev && (prev.source.kind === "paste" || prev.source.kind === "file")
          ? prev.source
          : { kind: "paste" },
    }));
  }, []);

  /** After "Save token" in the dialog: retry the repository load that was refused. */
  const tokenChanged = useCallback(
    (token: string | null) => {
      const repo = retryRepo.current;
      if (token && repo) void loadFromRepo({ ...repo, token }).then((r) => apply(r, repo));
    },
    [apply],
  );

  return {
    doc,
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
