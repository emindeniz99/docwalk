/**
 * Security headers for every response the Worker produces (decision 34).
 *
 * Asset requests outside `/api/*` never reach the Worker (wrangler.jsonc
 * `run_worker_first`), so the static-assets `_headers` file must carry the
 * same values; `headersFile()` renders it and a test keeps the two equal.
 */

import { CONTENT_SECURITY_POLICY } from "./csp";

export { CONTENT_SECURITY_POLICY };

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Fullscreen stays allowed: presenting uses it.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * Returns `response` with the security headers set. Asset and subrequest
 * responses have immutable headers, so the response is rebuilt. A WebSocket
 * upgrade (101) is returned untouched: it cannot be rebuilt and is not a page.
 */
export function withSecurityHeaders(response: Response): Response {
  if (response.status === 101 || response.webSocket) return response;
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}

/** The static-assets `_headers` file with the same values, for every path. */
export function headersFile(): string {
  const lines = Object.entries(SECURITY_HEADERS).map(([name, value]) => `  ${name}: ${value}`);
  return `/*\n${lines.join("\n")}\n`;
}
