# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Only the
maintainers see the report, and you can discuss the fix with them there.
Please do not open a public issue.

GitHub offers private vulnerability reporting on public repositories only.
The maintainers switch it on when the repository goes public; until then,
the form is not available.

Include what an attacker needs (a document, a link, a room, a deployment
setting), what they gain, and the browser and version you tested.

## Supported versions

docwalk has no release yet. Until the first one, fixes land on `main` only.
After it, the latest release and `main` get security fixes; older releases
do not.

## Threat model in brief

docwalk treats every document, link and room message as hostile. What it
protects:

- **The viewer's browser against the document.** Markdown passes through
  rehype-sanitize with GitHub's schema and then DOMPurify. Mermaid runs in
  `strict` mode after a pre-pass that strips `%%{init}%%` overrides and CSS
  `url()`; docwalk refuses a diagram that names a remote image, and passes
  Mermaid's SVG through DOMPurify too. Code colours are added after both
  sanitizers, as text and class names only. Formulas are drawn after both
  too: Temml runs with `trust` off and limits on length, nesting and size,
  and docwalk copies its MathML into fresh elements, keeping only listed
  element names, attributes, values and classes; the exports hold MathML to
  the same lists. Emoji shortcodes change the text of text nodes and nothing
  else. The deployed site sends
  a content security policy with `script-src 'self'` (plus, by its hash,
  the one inline script: the check for browsers too old to run docwalk)
  and `frame-ancestors 'none'`. A static host gets the same policy from a
  `<meta>` tag, which cannot forbid framing.
- **The viewer's privacy.** Remote images load only on a click or with the
  "Always load remote images" setting. A `?src=` link to a host other than
  GitHub's raw and gist hosts asks before fetching. docwalk sends no
  analytics or telemetry.
- **GitHub credentials.** A pasted token lives in `sessionStorage` for one
  tab. Sign-in uses a GitHub App with read access to the repositories the
  user picks, PKCE and a fixed redirect URI. The Worker exchanges codes,
  stores nothing and logs no tokens.
- **Rooms.** The phone remote, followers and agents exchange AES-GCM
  messages under keys that live only in the link's fragment. The Worker
  relays ciphertext, caps frame size and room size, and never sees a key or
  a document. A replayed frame is dropped. The control key steers the deck
  and reads and writes the document; the view key in a follow link only
  receives state, and only state the presenter signed. The presenter's
  laser, pen marks and diagram focus view reach followers the same way: as
  signed `mirror` messages under the view key, never to remotes or agents.
  A mirror message holds numbers, a tool, a colour key and a slide address
  only; a receiver draws the marks itself, caps what it keeps, and a
  follower cannot sign one. The presenter resends a slide's marks to a
  follower that says hello at most every 2 s, and less often the more the
  last resend cost, and answers hellos with at most one state per 250 ms.
  The join links appear once the presenter's socket is open, and a
  presenter whose room someone else reached first moves to a new room.
  Agent writes apply only while the presenter has switched on "Allow agent
  edits".

Known limits, by design:

- Anyone holding a room's control link can read the document and steer the
  deck. Share it like a password.
- Followers share one view key, but they take state only when the
  presenter's per-room signing key signed it; the public half is in the
  follow link. A follower, or the relay, can still repeat a frame the
  presenter signed to a follower that has not seen a later one from the
  same presenter tab: one that joins late or reconnects, and, once the
  presenter reloads its tab, any follower that never saw the earlier tab.
  A repeated state lasts until the presenter's next one and a laser point
  for 3 s; a mark stays until the presenter clears that slide, returns to
  it or resends its marks, and a focus view until Escape or the next
  resend. A relay can drop the message that hides a laser or closes a focus
  view. A tab that reloads can receive a frame it saw before the reload.
- The relay sees room ids, frame sizes and timing.
- Whoever hosts docwalk serves its code. A hostile host, a compromised
  browser or a malicious extension is out of scope.
