import { SELF, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, headersFile } from "./headers";
import worker from "./index";

const ORIGIN = "https://docwalk.test";

function securityHeadersOf(response: Response): Record<string, string | null> {
  return Object.fromEntries(
    Object.keys(SECURITY_HEADERS).map((name) => [name, response.headers.get(name)]),
  );
}

describe("security headers", () => {
  it("sends the CSP on API responses, so a JSON error can never be framed or sniffed as HTML", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/health`);
    await response.body?.cancel();
    expect(securityHeadersOf(response)).toEqual(SECURITY_HEADERS);
  });

  it("sends the CSP on the SPA the Worker falls through to, which is the page scripts run in", async () => {
    // /api/* runs the Worker first; an unknown API path falls through to the
    // assets binding. A stub stands in for it, so the test does not depend on
    // a dist/ left over from an earlier build (CI runs this before `pnpm build`).
    const requested: string[] = [];
    const assets = {
      fetch: (request: Request) => {
        requested.push(new URL(request.url).pathname);
        return Promise.resolve(
          new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }),
        );
      },
    } as unknown as Fetcher;
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/not-a-route`) as Parameters<typeof worker.fetch>[0],
      { ...env, ASSETS: assets },
      createExecutionContext(),
    );
    expect(requested).toEqual(["/api/not-a-route"]);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    await response.body?.cancel();
    expect(securityHeadersOf(response)).toEqual(SECURITY_HEADERS);
  });

  it("keeps the policy the decision names: no inline script, no framing, confirmed hosts and the relay reachable", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self';");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe/);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' https: data: blob:");
    // Decision 6 lets the viewer confirm a ?src= load from any https host, so a
    // host list here would block what the app just asked the viewer to allow.
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' https: wss:");
  });
});

describe("static assets _headers", () => {
  // Paths outside /api/* never run the Worker, so Cloudflare applies public/_headers
  // (copied into dist/ by Vite) to them. If that file drifts from headers.ts, the
  // page itself loses the CSP while every test of the Worker stays green.
  it("public/_headers matches the Worker's headers", () => {
    // null means the file is missing: create it with headersFile()'s output.
    expect({ "public/_headers": inject("publicHeaders") }).toEqual({
      "public/_headers": headersFile(),
    });
  });
});
