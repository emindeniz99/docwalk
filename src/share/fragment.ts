/**
 * The share fragment (decision 7): `#doc=<base64url(deflate-raw(utf8))>`.
 * The browser never sends a fragment to a server, so a pasted document can
 * travel inside the link. The fragment is untrusted input (decision 46): a
 * link may be hand-edited or hostile, so decoding validates the alphabet and
 * length first and stops reading a decompression bomb at the document cap.
 */
import * as v from "valibot";
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import { FRAGMENT_MAX_CHARS } from "./types";

export const DOC_HASH_PREFIX = "#doc=";
/** The fragment parameter that carries comments: `#doc=…&c=…`, or `#c=…` on a source link (decision 55). */
export const COMMENTS_PARAM = "c";

const FragmentSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(FRAGMENT_MAX_CHARS),
  v.regex(/^[A-Za-z0-9_-]+$/),
);

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Stop the inflater: reading on would make the bomb do its work.
      await reader.cancel().catch(() => {});
      throw new RangeError("decompressed document is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // Chunked, because spreading a large array into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  // A base64 length of 1 mod 4 cannot come from any byte sequence.
  if (text.length % 4 === 1) return null;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The fragment value (without `#doc=`) for a Markdown document. */
export async function encodeDoc(markdown: string): Promise<string> {
  const input = new Blob([new TextEncoder().encode(markdown)]).stream();
  const compressed = await readAll(
    input.pipeThrough(new CompressionStream("deflate-raw")),
    Number.POSITIVE_INFINITY,
  );
  return toBase64Url(compressed);
}

/**
 * The Markdown inside a fragment value, or `null` when the value is not one
 * docwalk wrote: a wrong alphabet, longer than a share link may be, not
 * deflate data, inflating past the document cap, or not valid UTF-8.
 */
export async function decodeDoc(fragmentValue: string): Promise<string | null> {
  if (!v.safeParse(FragmentSchema, fragmentValue).success) return null;
  const bytes = fromBase64Url(fragmentValue);
  if (bytes === null) return null;
  try {
    const inflated = await readAll(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
      MAX_DOCUMENT_BYTES,
    );
    // ignoreBOM keeps a leading U+FEFF (files saved by some Windows editors
    // start with one); the default decoder drops it and the trip is not exact.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(inflated);
  } catch {
    return null;
  }
}

/** Whether a location hash is a share fragment (valid or not). */
export function isDocHash(hash: string): boolean {
  return hash.startsWith(DOC_HASH_PREFIX);
}

/**
 * The document in `location.hash` when it is `#doc=…`; `null` for any other
 * hash (slide addresses belong to src/url) and for a damaged fragment. Use
 * `isDocHash` to tell the two apart.
 */
export async function readFragment(hash: string): Promise<string | null> {
  // A link may carry more after the document (`&c=…`, comments, decision 55);
  // the document value itself never contains `&`.
  return isDocHash(hash) ? decodeDoc(hash.slice(DOC_HASH_PREFIX.length).split("&")[0] ?? "") : null;
}
