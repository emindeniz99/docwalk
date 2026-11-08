# docwalk-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets a coding agent
(Claude Code, Codex, any client that runs stdio servers) read and edit the
document a docwalk presenter is showing, and move the deck.

It joins the presenter's remote-control room with the room's join link, the
same way a phone remote does. Everything it sends is encrypted with the room
key from the link, so the Worker relays ciphertext and never sees the
document (decision 59). The presenter decides whether the agent may change
anything.

## Tools

| Tool             | What it does                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_document`   | Returns the Markdown and its revision.                                                                                                                                                                |
| `write_document` | Replaces the whole document. Pass the revision from `get_document` as `base_revision` and the write is refused if the presenter edited in between. Answers with the rebuilt slide list and its notes. |
| `list_slides`    | Lists slides as the presenter's deck renders them: address, title, the current one, and notes for slides that overflow or whose diagram failed.                                                       |
| `goto_slide`     | Moves the deck to an address (`retries/2`), a section id (`retries`) or a slide number (`3`).                                                                                                         |

Reading and moving work as soon as the agent is in the room. Writing works
only while the presenter has **Allow agent edits** switched on in the Remote
control dialog. The switch is off in every new room and after a reload. Each
applied write shows a notice naming the agent, and the dialog keeps the last
one ("Last changed by claude-code at 14:03").

## Get a join link

1. Open docwalk in full mode (a deployment with the Worker; static hosting
   has no rooms).
2. More actions › **Remote and followers…**
3. Copy the **Phone remote** link. It ends in `#room=…&k=…`. The
   **Follow along** link (`#room=…&v=…`) does not work here: it holds only
   the view key, which can watch the deck but not move it or read the
   document.
4. Switch on **Allow agent edits** when you want the agent to change the
   document.

An agent holds the control key only. The presenter's laser, pen marks and
diagram focus view go to followers under the view key, so an agent never
receives them.

The link contains the room key. Anyone who has it can follow the deck, move
it, and, with agent edits on, replace the document. Keep it out of files
that are committed or shared: use the local or user scope of your client's
MCP config, never a project file in git.

## Run it

docwalk-mcp is not published to npm yet. Build it from this repository:

```sh
pnpm install
pnpm build            # builds the app and mcp/dist/docwalk-mcp.js
```

Then run `node <path>/mcp/dist/docwalk-mcp.js "<join link>"`, or set the link
in `DOCWALK_JOIN`. Node 22 or newer.

| Variable             | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `DOCWALK_JOIN`       | The join link, when it is not the first argument.               |
| `DOCWALK_AGENT_NAME` | The name the presenter sees on edits. Default: the client name. |

### Claude Code

```sh
claude mcp add docwalk --env DOCWALK_JOIN='https://docwalk.example/?view=remote#room=…&k=…' \
  -- node /path/to/docwalk/mcp/dist/docwalk-mcp.js
```

`claude mcp add` uses the local scope by default, which stays out of the
repository. A new room (a new presenter tab) has a new link: run
`claude mcp remove docwalk` and add it again.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.docwalk]
command = "node"
args = ["/path/to/docwalk/mcp/dist/docwalk-mcp.js"]
env = { DOCWALK_JOIN = "https://docwalk.example/?view=remote#room=…&k=…" }
```

### Other clients

Any client that starts stdio servers takes the same command, arguments and
environment. Chat apps that only accept remote (HTTP) MCP servers cannot use
docwalk-mcp: a server running on the Worker would need the room key, which
would end the end-to-end encryption.

## How it talks to the room

The server reuses the app's room client (`../src/remote/client.ts`), so the
key handling, message validation and reconnects are the app's own. Every
frame carries a random sender id and a counter inside the ciphertext, and a
frame the client has already seen from that sender is dropped, so the relay
cannot replay an old write or an old slide. Agent
messages are addressed: requests carry the agent's id, answers carry it back,
and other participants drop answers that are not theirs. The relay drops
frames over 16 KB, so a document or slide list larger than that travels as
deflated, encrypted parts (`../src/remote/parts.ts`) that only the addressee
reassembles, with limits on how much a sender can make it hold.

The build bundles that shared code into one JavaScript file, because Node
will not run TypeScript from `node_modules`. The npm dependencies (the MCP
SDK, zod, valibot) stay external.

## Development

From the docwalk folder:

```sh
pnpm --filter docwalk-mcp build     # mcp/dist/docwalk-mcp.js
pnpm test                           # unit tests, mcp/src included
pnpm test:e2e                       # e2e/mcp.spec.ts runs the built bin against a real browser
```
