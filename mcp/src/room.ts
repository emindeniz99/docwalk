import { connectRoom, type RemoteStatus, type SocketFactory } from "../../src/remote/client.ts";
import { parseJoinFragment, randomId } from "../../src/remote/crypto.ts";
import type {
  AgentError,
  AgentSlide,
  RemoteMessage,
  RoomCredentials,
} from "../../src/remote/types.ts";

/**
 * The agent's seat in a docwalk room (decision 59). It joins with a join
 * link like a phone remote, so it uses the same client, key and checks as
 * the app (../../src/remote): the relay sees ciphertext only. Requests are
 * matched to answers by a random id; nothing is queued while the socket is
 * down, so a request made then fails with a message the agent can act on.
 */

export type RoomState = Extract<RemoteMessage, { type: "state" }>;

/** How long a request waits for the room to open and the presenter to answer. */
export const REQUEST_TIMEOUT_MS = 15_000;

const ERROR_TEXT: Record<AgentError, string> = {
  "edits-off":
    'The presenter has not allowed agent edits. Ask them to switch on "Allow agent edits" in docwalk\'s Remote control dialog, then try again.',
  conflict:
    "The document changed since you read it. Call get_document again and make your edit on the new text.",
  "no-document": "The presenter's document is still loading. Try again in a moment.",
  "too-large": "The document is over docwalk's 2 MB limit.",
};

/** A failure the agent should read: the presenter refused, or nobody answered. */
export class RoomError extends Error {
  constructor(
    message: string,
    readonly code: AgentError | "timeout",
  ) {
    super(message);
    this.name = "RoomError";
  }
}

/** The room in a join link (`…#room=<id>&k=<key>`) and the origin its relay lives on. */
export function parseJoinLink(link: string): { creds: RoomCredentials; base: string } | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const creds = parseJoinFragment(url.hash);
  return creds ? { creds, base: url.href } : null;
}

export interface RoomAgentOptions {
  link: string;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
  /** Called on every connection status change, for logging. */
  onStatus?: (status: RemoteStatus) => void;
}

interface Pending {
  accept: (message: RemoteMessage) => boolean;
  resolve: (message: RemoteMessage) => void;
}

export class RoomAgent {
  /** The presenter's latest announced slide, or null before the first. */
  state: RoomState | null = null;
  private status: RemoteStatus = "connecting";
  private readonly pending = new Set<Pending>();
  private readonly opened = new Set<() => void>();
  private readonly conn;
  private readonly timeoutMs: number;

  constructor({ link, socketFactory, timeoutMs = REQUEST_TIMEOUT_MS, onStatus }: RoomAgentOptions) {
    const parsed = parseJoinLink(link);
    if (!parsed) {
      throw new Error(
        "That is not a docwalk join link. Copy the phone remote link from the Remote control dialog: it ends in #room=…&k=….",
      );
    }
    this.timeoutMs = timeoutMs;
    this.conn = connectRoom({
      creds: parsed.creds,
      role: "agent",
      base: parsed.base,
      ...(socketFactory ? { socketFactory } : {}),
      onStatus: (status) => {
        this.status = status;
        onStatus?.(status);
        if (status === "open") for (const wake of this.opened) wake();
      },
      onMessage: (message) => this.receive(message),
    });
  }

  async getDocument(): Promise<{ markdown: string; revision: string }> {
    const reply = await this.request((request) => ({
      type: "doc-get",
      request,
      from: this.conn.id,
    }));
    if (reply.type !== "doc") throw failure(reply);
    return { markdown: reply.markdown, revision: reply.revision };
  }

  /** Replaces the document; `base` is the revision the edit started from, when known. */
  async writeDocument(
    markdown: string,
    { name, base }: { name: string; base: string | null },
  ): Promise<{ revision: string }> {
    const reply = await this.request((request) => ({
      type: "doc-write",
      request,
      from: this.conn.id,
      name,
      markdown,
      base,
    }));
    if (reply.type !== "result" || !reply.ok) throw failure(reply);
    return { revision: reply.revision };
  }

  async listSlides(): Promise<{ current: string | null; slides: AgentSlide[] }> {
    const reply = await this.request((request) => ({
      type: "slides-get",
      request,
      from: this.conn.id,
    }));
    if (reply.type !== "slides") throw failure(reply);
    return { current: reply.current, slides: reply.slides };
  }

  /** Asks the presenter to show `address`; resolves with the slide it shows afterwards. */
  async goTo(address: string): Promise<RoomState> {
    await this.whenOpen();
    // The presenter answers every goto with its state, moved or not.
    const answer = this.wait((m) => m.type === "state");
    await this.conn.send({ type: "goto", address });
    return (await answer) as RoomState;
  }

  close() {
    this.conn.close();
  }

  private receive(message: RemoteMessage) {
    if (message.type === "state") this.state = message;
    for (const entry of this.pending) {
      if (entry.accept(message)) {
        this.pending.delete(entry);
        entry.resolve(message);
      }
    }
  }

  private async request(build: (request: string) => RemoteMessage): Promise<RemoteMessage> {
    await this.whenOpen();
    const id = randomId();
    const answer = this.wait((m) => "request" in m && m.request === id && "to" in m);
    const sent = await this.conn.send(build(id));
    if (sent === "too-large") throw new RoomError(ERROR_TEXT["too-large"], "too-large");
    return answer;
  }

  private wait(accept: (message: RemoteMessage) => boolean): Promise<RemoteMessage> {
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        accept,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        this.pending.delete(entry);
        reject(
          new RoomError(
            "The presenter did not answer. Check that the docwalk tab that opened the room is still open and its Remote control is on.",
            "timeout",
          ),
        );
      }, this.timeoutMs);
      this.pending.add(entry);
    });
  }

  private whenOpen(): Promise<void> {
    if (this.status === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        this.opened.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        this.opened.delete(wake);
        reject(
          new RoomError(
            "Could not reach the docwalk room. Check the join link and the network; the presenter may have closed the room.",
            "timeout",
          ),
        );
      }, this.timeoutMs);
      this.opened.add(wake);
    });
  }
}

function failure(reply: RemoteMessage): RoomError {
  if (reply.type === "result" && !reply.ok)
    return new RoomError(ERROR_TEXT[reply.error], reply.error);
  return new RoomError("The presenter sent an unexpected answer.", "timeout");
}
