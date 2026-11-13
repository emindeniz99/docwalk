/**
 * Document loaders (decisions 5, 6 and 46). Every address, parameter and
 * response that crosses into the app is validated here; anything that does
 * not fit becomes a typed `LoadError`, never an exception and never HTML.
 */
import * as v from "valibot";
import { m } from "../paraglide/messages.js";
import { MAX_DOCUMENT_BYTES, type DocumentSource, type LoadError, type LoadResult } from "./types";

/** `fetch` as the loaders use it; tests pass a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface FetchOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** Hosts that serve raw GitHub content and load without a confirmation (decision 6). */
const TRUSTED_HOSTS: readonly string[] = [
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
];

/** Longest `?src=` address accepted; longer ones are not document links. */
const MAX_URL_LENGTH = 4096;

const GITHUB_API = "https://api.github.com";

// ---- Shapes ---------------------------------------------------------------

/** `owner/name` as GitHub allows them: owner alphanumeric with inner hyphens, name without `.`/`..`. */
const RepoSchema = v.pipe(
  v.string(),
  v.maxLength(140),
  v.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/),
);

/**
 * A file path inside the repository: relative, `/`-separated, no empty,
 * `.` or `..` segment, no backslash or control character. Each segment is
 * percent-encoded when the API URL is built, so `?` and `#` cannot escape.
 */
const PathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1024),
  v.check(
    (path) =>
      // oxlint-disable-next-line no-control-regex -- control characters are exactly what this rejects
      !/[\\\u0000-\u001f\u007f]/.test(path) &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
);

/** A branch, tag or commit: the ASCII subset of git's ref rules. */
const RefSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
  v.regex(/^[A-Za-z0-9._/-]+$/),
  v.check(
    (ref) => !ref.includes("..") && !ref.includes("//") && !/^[/-]/.test(ref) && !ref.endsWith("/"),
  ),
);

/** Token shape check before it goes into a header: GitHub tokens are `[A-Za-z0-9_]`. */
const TokenSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]{20,255}$/));

const valid = <T>(schema: v.GenericSchema<unknown, T>, input: unknown): input is T =>
  v.safeParse(schema, input).success;

// ---- URL policy -----------------------------------------------------------

type UrlCheck = { ok: true; url: URL; trusted: boolean } | { ok: false; message: string };

/** True for the raw GitHub hosts on the default port. The parser has already turned IDN into punycode. */
function isTrustedUrl(url: URL): boolean {
  return url.protocol === "https:" && url.port === "" && TRUSTED_HOSTS.includes(url.hostname);
}

/**
 * The `?src=` policy: https only, no credentials in the address. A host is
 * trusted only on an exact match, so `raw.githubusercontent.com.evil.example`
 * or a Cyrillic lookalike (which the URL parser turns into `xn--…`) falls to
 * the confirmation prompt, which shows the ASCII host.
 */
export function checkUrlPolicy(raw: string): UrlCheck {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, message: m.load_url_too_long() };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: m.load_url_invalid() };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: m.load_url_https() };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: m.load_url_credentials() };
  }
  if (url.hostname === "") return { ok: false, message: m.load_url_no_host() };
  return { ok: true, url, trusted: isTrustedUrl(url) };
}

// ---- Query parameters -----------------------------------------------------

export type InputRequest =
  | { kind: "url"; url: string }
  | { kind: "repo"; repo: string; path: string; ref: string | null };

/** `null`: the link names no document. `invalid`: it names one in a shape docwalk will not load. */
type ParsedInput = InputRequest | { kind: "invalid"; message: string } | null;

/**
 * Reads `?src=<url>` or `?repo=<owner>/<name>&path=<path>[&ref=<ref>]`. A
 * link carrying both, or a parameter twice, is ambiguous and rejected rather
 * than guessed at.
 */
export function parseInputUrl(input: string | URL): ParsedInput {
  let params: URLSearchParams;
  try {
    params = new URL(input).searchParams;
  } catch {
    return null;
  }
  const all = (name: string) => params.getAll(name);
  const [src, repo, path, ref] = [all("src"), all("repo"), all("path"), all("ref")];
  if (src.length === 0 && repo.length === 0 && path.length === 0) return null;
  if ([src, repo, path, ref].some((values) => values.length > 1)) {
    return { kind: "invalid", message: m.load_link_repeats() };
  }
  if (src.length > 0 && (repo.length > 0 || path.length > 0)) {
    return { kind: "invalid", message: m.load_link_both() };
  }
  if (src[0] !== undefined) {
    const check = checkUrlPolicy(src[0]);
    return check.ok
      ? { kind: "url", url: check.url.href }
      : { kind: "invalid", message: check.message };
  }
  const [r, p, f] = [repo[0], path[0], ref[0] || null];
  if (!valid(RepoSchema, r)) {
    return { kind: "invalid", message: m.load_repo_shape() };
  }
  if (!valid(PathSchema, p)) {
    return { kind: "invalid", message: m.load_link_path() };
  }
  if (f !== null && !valid(RefSchema, f)) {
    return { kind: "invalid", message: m.load_link_ref() };
  }
  return { kind: "repo", repo: r, path: p, ref: f };
}

// ---- Bodies ---------------------------------------------------------------

/**
 * Reads a body without holding more than `max` bytes: a declared
 * Content-Length above the cap is refused before reading, and the stream is
 * cancelled as soon as it passes the cap (the header may lie or be absent).
 */
export async function readCapped(
  response: Response,
  max: number = MAX_DOCUMENT_BYTES,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; bytes: number }> {
  const declared = response.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared)) {
    const length = Math.min(Number(declared), Number.MAX_SAFE_INTEGER);
    if (length > max) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, bytes: length };
    }
  }
  if (!response.body) return { ok: true, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { ok: false, bytes: total };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** Strict UTF-8: binary posing as text is refused instead of rendered as mojibake. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Text or a generic byte stream. A missing Content-Type counts as
 * `application/octet-stream`, which is what HTTP says a recipient may assume.
 */
function isTextual(type: string): boolean {
  return type === "" || type.startsWith("text/") || type === "application/octet-stream";
}

const fail = (error: LoadError): LoadResult => ({ ok: false, error });

async function finish(response: Response, source: DocumentSource): Promise<LoadResult> {
  const body = await readCapped(response);
  if (!body.ok) return fail({ kind: "too-large", bytes: body.bytes });
  const markdown = decodeUtf8(body.bytes);
  if (markdown === null) return fail({ kind: "invalid", message: m.load_not_utf8_document() });
  return { ok: true, doc: { markdown, source } };
}

function networkError(error: unknown): LoadResult {
  if (error instanceof DOMException && error.name === "AbortError") {
    return fail({ kind: "network", message: m.load_cancelled() });
  }
  // A cross-origin server without CORS headers lands here too; the browser hides which it was.
  return fail({
    kind: "network",
    message: m.load_fetch_failed(),
  });
}

function statusError(response: Response, from: "url" | "repo"): LoadResult | null {
  if (response.ok) return null;
  if (response.status === 404) return fail({ kind: "not-found", from });
  if (response.status === 401) return fail({ kind: "unauthorized" });
  if (response.status === 403) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      return fail({
        kind: "network",
        message: m.load_rate_limit(),
      });
    }
    return fail({ kind: "unauthorized" });
  }
  return fail({ kind: "network", message: m.load_http_status({ status: response.status }) });
}

/** Calls the global fetch with its own receiver, wherever it was looked up. */
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const withSignal = (signal: AbortSignal | undefined): RequestInit => (signal ? { signal } : {});

// ---- Loaders --------------------------------------------------------------

/**
 * `?src=` (decision 6). raw.githubusercontent.com and gist.githubusercontent.com
 * load directly; any other https host returns `needs-confirmation` until the
 * user confirms it. A redirect that leaves the trusted hosts asks again.
 */
export async function loadFromUrl(
  raw: string,
  options: FetchOptions & { confirmed?: boolean } = {},
): Promise<LoadResult> {
  const check = checkUrlPolicy(raw);
  if (!check.ok) return fail({ kind: "invalid", message: check.message });
  const { url, trusted } = check;
  if (!trusted && !options.confirmed) {
    return fail({ kind: "needs-confirmation", url: url.href, host: url.host });
  }
  const doFetch = options.fetch ?? defaultFetch;
  let response: Response;
  try {
    response = await doFetch(url.href, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
      ...withSignal(options.signal),
    });
  } catch (error) {
    return networkError(error);
  }
  const final = response.url ? new URL(response.url) : url;
  if (final.protocol !== "https:") {
    await response.body?.cancel().catch(() => {});
    return fail({ kind: "invalid", message: m.load_redirect_http() });
  }
  if (!options.confirmed && !isTrustedUrl(final)) {
    await response.body?.cancel().catch(() => {});
    return fail({ kind: "needs-confirmation", url: final.href, host: final.host });
  }
  const status = statusError(response, "url");
  if (status) return status;
  if (!isTextual(mediaType(response))) {
    await response.body?.cancel().catch(() => {});
    return fail({ kind: "invalid", message: m.load_not_text() });
  }
  return finish(response, { kind: "url", url: final.href, trusted: isTrustedUrl(final) });
}

interface RepoLoadRequest {
  repo: string;
  path: string;
  ref: string | null;
  /** A pasted or OAuth token for private repositories; sent only to api.github.com. */
  token?: string | null;
}

/** `?repo=&path=[&ref=]` through the GitHub REST contents API, raw media type. */
export async function loadFromRepo(
  request: RepoLoadRequest,
  options: FetchOptions = {},
): Promise<LoadResult> {
  const { repo, path, ref, token } = request;
  if (!valid(RepoSchema, repo)) {
    return fail({ kind: "invalid", message: m.load_repo_shape() });
  }
  if (!valid(PathSchema, path)) {
    return fail({ kind: "invalid", message: m.load_path_invalid() });
  }
  if (ref !== null && !valid(RefSchema, ref)) {
    return fail({ kind: "invalid", message: m.load_ref_invalid() });
  }
  if (token != null && !valid(TokenSchema, token)) {
    return fail({ kind: "invalid", message: m.load_token_invalid() });
  }
  const [owner, name] = repo.split("/") as [string, string];
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const query = ref === null ? "" : `?ref=${encodeURIComponent(ref)}`;
  const endpoint = `${GITHUB_API}/repos/${owner}/${name}/contents/${encodedPath}${query}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const doFetch = options.fetch ?? defaultFetch;
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      headers,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...withSignal(options.signal),
    });
  } catch (error) {
    return networkError(error);
  }
  const status = statusError(response, "repo");
  if (status) return status;
  const type = mediaType(response);
  // A directory comes back as a JSON listing even with the raw media type.
  if (!isTextual(type) && !type.startsWith("application/vnd.github.raw")) {
    await response.body?.cancel().catch(() => {});
    return fail({ kind: "invalid", message: m.load_is_folder() });
  }
  return finish(response, { kind: "repo", repo, path, ref });
}

/** Extensions the file picker offers; the picker's filter can be bypassed, so this is checked again. */
const ACCEPTED_FILE = /\.(md|markdown|txt)$/i;

/** A local file from the picker or a drop, with the same size cap and UTF-8 check as a fetch. */
export async function loadFromFile(file: File): Promise<LoadResult> {
  if (!ACCEPTED_FILE.test(file.name)) {
    return fail({ kind: "invalid", message: m.load_file_type() });
  }
  if (file.size > MAX_DOCUMENT_BYTES) return fail({ kind: "too-large", bytes: file.size });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    // The file was moved, deleted or blocked between picking and reading.
    return fail({ kind: "invalid", message: m.load_file_unreadable() });
  }
  const markdown = decodeUtf8(bytes);
  if (markdown === null) return fail({ kind: "invalid", message: m.load_file_not_utf8() });
  return { ok: true, doc: { markdown, source: { kind: "file", name: file.name } } };
}

/** A sentence for each error, for the banner or a notice. */
export function describeLoadError(error: LoadError): string {
  switch (error.kind) {
    case "needs-confirmation":
      return m.source_confirm_title({ host: error.host });
    case "not-found":
      // Only a ?repo= load carries the token, so only there can one help.
      return error.from === "repo" ? m.load_not_found() : m.load_url_not_found();
    case "unauthorized":
      return m.load_unauthorized();
    case "too-large":
      return m.load_too_large({ mb: MAX_DOCUMENT_BYTES / 1024 / 1024 });
    case "network":
    case "invalid":
      return error.message;
  }
}
