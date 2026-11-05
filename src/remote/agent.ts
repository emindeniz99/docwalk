import { MAX_NOTE_CHARS, MAX_TITLE_CHARS, toBase64Url } from "./crypto";
import type { AgentSlide, RemoteMessage } from "./types";

/**
 * The presenter's answers to an agent (decision 59): the document, the slide
 * list and document writes. Kept apart from the React hook (host.ts) so the
 * rules are tested without a deck: a write is applied only while the
 * presenter allows agent edits, and only onto the revision the agent read
 * when it names one.
 */

export type AgentRequest = Extract<RemoteMessage, { type: "doc-get" | "doc-write" | "slides-get" }>;

export interface AgentHostContext {
  /** The presenter's document, or null while it loads. */
  markdown(): string | null;
  /** The rendered deck; resolves once the deck shows the current document. */
  slides(): Promise<{ current: string | null; slides: AgentSlide[] }>;
  /** The "Allow agent edits" switch for this room. */
  allowEdits(): boolean;
  /** Replaces the document; `name` is the agent the presenter is told about. */
  apply(markdown: string, name: string): void;
  /** A write arrived while edits are off. */
  refused(name: string): void;
}

const encoder = new TextEncoder();

/**
 * The document's revision: 16 bytes of its SHA-256, base64url. A hash, not a
 * counter, so an agent and a reloaded presenter tab agree on it without
 * either remembering anything.
 */
export async function revisionOf(markdown: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(markdown));
  return toBase64Url(new Uint8Array(digest, 0, 16));
}

export function isAgentRequest(message: RemoteMessage): message is AgentRequest {
  return (
    message.type === "doc-get" || message.type === "doc-write" || message.type === "slides-get"
  );
}

/** The presenter's reply to `request`. */
export async function answerAgent(
  request: AgentRequest,
  ctx: AgentHostContext,
): Promise<RemoteMessage> {
  const reply = { request: request.request, to: request.from };
  switch (request.type) {
    case "doc-get": {
      const markdown = ctx.markdown();
      if (markdown === null) return { type: "result", ...reply, ok: false, error: "no-document" };
      return { type: "doc", ...reply, markdown, revision: await revisionOf(markdown) };
    }
    case "slides-get": {
      const { current, slides } = await ctx.slides();
      return {
        type: "slides",
        ...reply,
        current,
        slides: slides.map((s) => ({
          address: s.address,
          title: s.title.slice(0, MAX_TITLE_CHARS),
          note: s.note === null ? null : s.note.slice(0, MAX_NOTE_CHARS),
        })),
      };
    }
    case "doc-write": {
      if (!ctx.allowEdits()) {
        ctx.refused(request.name);
        return { type: "result", ...reply, ok: false, error: "edits-off" };
      }
      const markdown = ctx.markdown();
      if (markdown === null) return { type: "result", ...reply, ok: false, error: "no-document" };
      if (request.base !== null && request.base !== (await revisionOf(markdown))) {
        return { type: "result", ...reply, ok: false, error: "conflict" };
      }
      ctx.apply(request.markdown, request.name);
      return { type: "result", ...reply, ok: true, revision: await revisionOf(request.markdown) };
    }
  }
}
