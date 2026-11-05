import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RoomAgent } from "./room.ts";
import { createServer, VERSION } from "./server.ts";

/**
 * `docwalk-mcp <join link>`: a stdio MCP server for one docwalk room
 * (decision 59). stdout carries the MCP protocol, so everything for people
 * goes to stderr, and the join link is never printed: it holds the room key.
 */

const USAGE = `docwalk-mcp ${VERSION}

Usage: docwalk-mcp <join link>
       DOCWALK_JOIN=<join link> docwalk-mcp

The join link is the phone remote link from docwalk's Remote control dialog.
It contains the room key: keep it out of shared files.

Environment:
  DOCWALK_JOIN        the join link, when it is not given as an argument
  DOCWALK_AGENT_NAME  the name the presenter sees on your edits
                      (default: the MCP client's name)
`;

function main() {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (arg === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const link = arg ?? process.env["DOCWALK_JOIN"];
  if (!link) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  let room: RoomAgent;
  try {
    room = new RoomAgent({
      link,
      onStatus: (status) => process.stderr.write(`docwalk-mcp: room ${status}\n`),
    });
  } catch (error) {
    process.stderr.write(`docwalk-mcp: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const server = createServer(room, { agentName: process.env["DOCWALK_AGENT_NAME"] });
  const transport = new StdioServerTransport();
  // The client closing stdin ends the session; the room socket must not keep Node alive.
  process.stdin.on("end", () => {
    room.close();
    void server.close();
  });
  server.connect(transport).catch((error: unknown) => {
    process.stderr.write(`docwalk-mcp: ${(error as Error).message}\n`);
    room.close();
    process.exitCode = 1;
  });
}

main();
