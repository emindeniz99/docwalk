import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { outline, ready, replaceSource, SHORT_DOC } from "./helpers";

/**
 * An agent edits the presenter's deck through docwalk-mcp (decision 59).
 * The MCP server is the built bin, spawned the way Claude Code or Codex
 * spawns it and spoken to over stdio, so this tests what users install.
 * Its room socket cannot be routed by Playwright, so a local relay plays the
 * Worker (forward each frame unread to the room's other sockets, drop frames
 * over 16 KB) and the presenter page's socket is bridged into it.
 */

const BIN = new URL("../mcp/dist/docwalk-mcp.js", import.meta.url);
const FIXTURE = readFileSync(new URL("../fixtures/ledger-redesign.md", import.meta.url), "utf8");
const MAX_FRAME_BYTES = 16 * 1024;

/** The Worker's room relay (worker/room.ts) on a local port. */
async function startRelay() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const rooms = new Map<WebSocket, string>();
  const oversized: number[] = [];
  server.on("connection", (socket, request) => {
    rooms.set(socket, request.url ?? "");
    socket.on("message", (data) => {
      const frame = data.toString();
      if (frame.length > MAX_FRAME_BYTES) {
        oversized.push(frame.length);
        return;
      }
      for (const [peer, room] of rooms) {
        if (peer !== socket && room === request.url && peer.readyState === WebSocket.OPEN) {
          peer.send(frame);
        }
      }
    });
    socket.on("close", () => rooms.delete(socket));
  });
  const { port } = server.address() as { port: number };
  return { port, oversized, close: () => server.close() };
}

/** /api/health offers remote control, and the page's room socket is bridged to the relay. */
async function fullMode(context: BrowserContext, relayPort: number) {
  await context.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, features: ["remote"] } }),
  );
  await context.routeWebSocket(/\/api\/remote\/[\w-]{22,64}$/, (route) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${relayPort}${new URL(route.url()).pathname}`);
    const waiting: string[] = [];
    upstream.on("open", () => waiting.splice(0).forEach((frame) => upstream.send(frame)));
    upstream.on("message", (data) => route.send(data.toString()));
    route.onMessage((frame) => {
      const text = String(frame);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else waiting.push(text);
    });
    route.onClose(() => upstream.close());
  });
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** A minimal MCP client over the bin's stdio: newline-delimited JSON-RPC. */
async function startAgent(link: string, name: string) {
  expect(existsSync(BIN), "build docwalk-mcp first (pnpm build)").toBe(true);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN.pathname, link]);
  const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as { id?: number; result?: unknown };
      buffer = buffer.slice(newline + 1);
      if (message.id !== undefined) waiting.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    async call(tool: string, args: Record<string, unknown> = {}) {
      const reply = await rpc("tools/call", { name: tool, arguments: args });
      expect(reply.error).toBeUndefined();
      const result = reply.result as ToolResult;
      return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
    },
    stop: () => child.stdin.end(),
  };
}

/** Opens Remote control and returns the phone remote link, pointed at the local relay. */
async function agentLink(page: Page, relayPort: number) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = page.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const link = new URL(
    await dialog.getByRole("textbox", { name: "Phone remote link" }).inputValue(),
  );
  link.protocol = "http:";
  link.host = `127.0.0.1:${relayPort}`;
  return link.href;
}

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Remote control" });
/** The switch's visible label; React Aria keeps the input itself visually hidden. */
const switchLabel = (page: Page) => dialogOf(page).locator("label.docwalk-switch");

test("the presenter's switch gates agent writes, and the notice says which agent tried", async ({
  context,
}) => {
  const relay = await startRelay();
  await fullMode(context, relay.port);
  const page = await context.newPage();
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);
  const link = await agentLink(page, relay.port);
  const toggle = dialogOf(page).getByRole("switch", { name: "Allow agent edits" });
  await expect(toggle).not.toBeChecked();
  await dialogOf(page).getByRole("button", { name: "Close" }).click();

  const agent = await startAgent(link, "e2e-agent");
  try {
    // Reading needs no permission.
    expect((await agent.call("get_document")).content[0]?.text).toBe(SHORT_DOC);

    const refused = await agent.call("write_document", { markdown: "# Taken over\n" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Allow agent edits");
    const notice = page.locator(".docwalk-notice");
    await expect(notice).toContainText("e2e-agent tried to change the document");
    await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);

    // The notice leads straight to the switch.
    await notice.getByRole("button", { name: "Remote control" }).click();
    await expect(dialogOf(page)).toBeVisible();
    await expect(dialogOf(page).getByText("1 agent connected")).toBeVisible();
    await switchLabel(page).click();
    await expect(toggle).toBeChecked();
    await dialogOf(page).getByRole("button", { name: "Close" }).click();

    const written = await agent.call("write_document", {
      markdown: `${SHORT_DOC}\n## Added by the agent\n\nGamma.\n`,
    });
    expect(written.isError).toBeFalsy();
    await expect(page.locator(".docwalk-outline-item")).toHaveCount(4);
    await expect(notice).toContainText("e2e-agent changed the document.");

    // Switched off again, writes stop again.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Remote and followers…" }).click();
    await switchLabel(page).click();
    await expect(toggle).not.toBeChecked();
    expect((await agent.call("write_document", { markdown: "# Again\n" })).isError).toBe(true);
    await expect(page.locator(".docwalk-outline-item")).toHaveCount(4);
  } finally {
    agent.stop();
    relay.close();
  }
});

test("an agent's tool calls rewrite and steer the presenter's deck, a long doc included", async ({
  context,
}) => {
  const relay = await startRelay();
  await fullMode(context, relay.port);
  const page = await context.newPage();
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);
  const link = await agentLink(page, relay.port);
  await switchLabel(page).click();
  await expect(dialogOf(page).getByRole("switch", { name: "Allow agent edits" })).toBeChecked();
  await dialogOf(page).getByRole("button", { name: "Close" }).click();

  const agent = await startAgent(link, "e2e-agent");
  try {
    const listed = await agent.call("list_slides");
    expect(listed.text).toContain("3 slides");
    expect(listed.text).toMatch(/first-point\/1 \| First point/);

    // A 30 KB design doc is larger than a relay frame: it must cross as parts, both ways.
    const read = await agent.call("get_document");
    const revision = /revision: ([\w-]{22})/.exec(read.text)?.[1];
    expect(revision).toBeDefined();
    const written = await agent.call("write_document", {
      markdown: FIXTURE,
      base_revision: revision,
    });
    expect(written.isError).toBeFalsy();
    // The reply lists the rebuilt deck, not the old one.
    expect(written.text).not.toContain("first-point/1");
    expect(written.text).toMatch(/\d{2,} slides/);
    await expect(page.locator(".docwalk-doc-title > strong")).not.toHaveText("Round trip");
    expect((await outline(page)).length).toBeGreaterThan(10);
    const back = await agent.call("get_document");
    expect(back.content[0]?.text).toBe(FIXTURE);
    expect(relay.oversized).toEqual([]);

    // A write against a revision that is no longer current is refused, not applied over it.
    const stale = await agent.call("write_document", {
      markdown: SHORT_DOC,
      base_revision: revision,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("changed since you read it");

    const moved = await agent.call("goto_slide", { slide: "3" });
    expect(moved.text).toMatch(/^Now on slide 3 of \d+/);
    await expect(page.locator(".docwalk-preview-head strong")).toHaveText(/^3 \/ \d+$/);

    // The dialog names the agent behind the last change, and stays accessible.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Remote and followers…" }).click();
    await expect(dialogOf(page).getByText(/Last changed by e2e-agent at/)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include(".docwalk-join")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" | ")}`),
    ).toEqual([]);
  } finally {
    agent.stop();
    relay.close();
  }
});
