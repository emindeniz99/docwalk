import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { MAX_AGENT_NAME_CHARS } from "../../src/remote/crypto.ts";
import type { AgentSlide } from "../../src/remote/types.ts";
import type { RoomAgent, RoomState } from "./room.ts";

/**
 * The MCP tools (decision 59): get_document, write_document, list_slides and
 * goto_slide. Each one is a request to the presenter's tab through the room;
 * failures come back as tool errors whose text says what to do next.
 */

export const VERSION = "0.0.0";

export type Room = Pick<RoomAgent, "getDocument" | "writeDocument" | "listSlides" | "goTo">;

export interface ServerOptions {
  /** The author name the presenter sees; defaults to the MCP client's name. */
  agentName?: string | undefined;
}

const FALLBACK_NAME = "An agent";

/** A name the presenter's notice can show: no control characters, at most 64 characters. */
export function cleanAgentName(name: string | undefined): string {
  const clean = (name ?? "")
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, MAX_AGENT_NAME_CHARS);
  return clean || FALLBACK_NAME;
}

const text = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }] });

/** Every failure becomes a tool error the model reads, never a protocol error. */
async function run(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

function describeSlides(current: string | null, slides: AgentSlide[]): string {
  if (slides.length === 0) return "The deck has no slides yet.";
  const lines = slides.map((slide, i) => {
    const marks = [
      slide.address === current ? "current" : null,
      slide.note ? `note: ${slide.note}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    return `${i + 1}. ${slide.address} | ${slide.title || "(untitled)"}${marks ? ` (${marks})` : ""}`;
  });
  const flagged = slides.filter((s) => s.note).length;
  return [
    `${slides.length} slides; ${flagged} with notes (content that does not fit or a diagram that failed).`,
    ...lines,
  ].join("\n");
}

function describeState(state: RoomState): string {
  return `Now on slide ${state.index + 1} of ${state.total}: ${state.current}${state.title ? ` | ${state.title}` : ""}`;
}

export function createServer(room: Room, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "docwalk-mcp", version: VERSION });
  const authorName = () =>
    cleanAgentName(options.agentName ?? server.server.getClientVersion()?.name);

  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description:
        "Returns the Markdown document the docwalk presenter is showing, and its revision. Slides are made from its headings; Mermaid code blocks become diagrams.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const { markdown, revision } = await room.getDocument();
        return {
          content: [
            { type: "text", text: markdown },
            {
              type: "text",
              text: `revision: ${revision} (pass it to write_document as base_revision, so your write is refused instead of overwriting edits made since)`,
            },
          ],
        };
      }),
  );

  server.registerTool(
    "write_document",
    {
      title: "Write document",
      description:
        'Replaces the whole Markdown document in the presenter\'s docwalk tab; the deck rebuilds from it. Works only while the presenter has "Allow agent edits" on. Read the document first and send the complete new text.',
      inputSchema: {
        markdown: z.string().describe("The complete new document."),
        base_revision: z
          .string()
          .optional()
          .describe(
            "The revision get_document returned; the write is refused if the document changed since.",
          ),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ markdown, base_revision }) =>
      run(async () => {
        const { revision } = await room.writeDocument(markdown, {
          name: authorName(),
          base: base_revision ?? null,
        });
        let deck = "";
        try {
          const { current, slides } = await room.listSlides();
          deck = `\n\n${describeSlides(current, slides)}`;
        } catch {
          // The write happened; the slide list is a courtesy.
        }
        return text(`Document written. New revision: ${revision}.${deck}`);
      }),
  );

  server.registerTool(
    "list_slides",
    {
      title: "List slides",
      description:
        "Lists the slides as the presenter's deck renders them: address, title, which one is showing, and any note (content that overflows the slide, a diagram that failed).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const { current, slides } = await room.listSlides();
        return text(describeSlides(current, slides));
      }),
  );

  server.registerTool(
    "goto_slide",
    {
      title: "Go to slide",
      description:
        'Moves the presenter\'s deck to a slide, by address from list_slides ("retries/2", or a section id such as "retries") or by 1-based slide number.',
      inputSchema: {
        slide: z
          .string()
          .min(1)
          .describe('A slide address, a section id, or a slide number such as "3".'),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    ({ slide }) =>
      run(async () => {
        let address = slide.trim();
        if (/^\d+$/.test(address)) {
          const { slides } = await room.listSlides();
          const target = slides[Number(address) - 1];
          if (!target)
            return {
              ...text(`There is no slide ${address}; the deck has ${slides.length}.`),
              isError: true,
            };
          address = target.address;
        }
        const state = await room.goTo(address);
        const arrived = state.current === address || state.current.startsWith(`${address}/`);
        if (!arrived) {
          return {
            ...text(
              `No slide has the address "${address}". ${describeState(state)}. Call list_slides for the addresses.`,
            ),
            isError: true,
          };
        }
        return text(describeState(state));
      }),
  );

  return server;
}
