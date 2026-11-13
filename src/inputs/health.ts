/**
 * The Worker's health check, apart from sign-in (decision 126): every visit
 * asks `/api/health` whether the Worker is there (rule 6), and only a sign-in
 * loads oauth.ts.
 */
import * as v from "valibot";
import type { HealthResponse } from "../api/types";
import { readCapped, type FetchLike } from "./load";

/** Largest JSON body read from `/api`. */
const MAX_API_BYTES = 16 * 1024;

/** GitHub App client ids (`Iv1.…`, `Iv23…`). */
export const ClientIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,128}$/));

const HealthSchema = v.object({
  ok: v.literal(true),
  features: v.pipe(v.array(v.string()), v.maxLength(32)),
  githubClientId: v.optional(v.string()),
});

export async function readJson(response: Response): Promise<unknown> {
  const body = await readCapped(response, MAX_API_BYTES);
  if (!body.ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * GET /api/health, or null in static mode. A static host may answer with the
 * SPA's index.html and a 200, so the body is validated, not the status.
 */
export async function fetchApiHealth(
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): Promise<HealthResponse | null> {
  try {
    const response = await fetchImpl("/api/health", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const parsed = v.safeParse(HealthSchema, await readJson(response));
    if (!parsed.success) return null;
    const clientId = parsed.output.githubClientId;
    const hasClientId = clientId !== undefined && v.safeParse(ClientIdSchema, clientId).success;
    // Unknown features from a newer Worker are ignored; "oauth" without a client id is unusable.
    const features = parsed.output.features.filter(
      (f): f is "oauth" | "remote" => f === "remote" || (f === "oauth" && hasClientId),
    );
    return {
      ok: true,
      features: [...new Set(features)],
      ...(hasClientId && features.includes("oauth") ? { githubClientId: clientId } : {}),
    };
  } catch {
    return null;
  }
}
