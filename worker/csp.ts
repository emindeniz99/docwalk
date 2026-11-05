/**
 * The Content-Security-Policy, on its own so the build (`tooling/csp-plugin.ts`)
 * can read it without the Worker's runtime types.
 */

/** decision 34; `img-src` per decision 33, `connect-src` per decision 6: any https host the viewer confirmed, plus the relay. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: wss:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
