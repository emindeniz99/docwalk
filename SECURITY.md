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
  Mermaid's SVG through DOMPurify too. The deployed site sends
  a content security policy with `script-src 'self'` and
  `frame-ancestors 'none'`. A static host gets the same policy from a
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
  receives state. Agent writes apply only while the presenter has switched
  on "Allow agent edits".

Known limits, by design:

- Anyone holding a room's control link can read the document and steer the
  deck. Share it like a password.
- Followers share one view key, so a follower can forge slide changes that
  other followers see. A tab that reloads can receive a frame it saw before
  the reload.
- The relay sees room ids, frame sizes and timing.
- Whoever hosts docwalk serves its code. A hostile host, a compromised
  browser or a malicious extension is out of scope.
