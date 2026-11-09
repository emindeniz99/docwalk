import { describe, expect, test } from "vitest";
import type { DocumentSource } from "../inputs/types";
import { legacySourceKey, sourceKey } from "./identity";

/**
 * A `?src=` document's identity is its address (decision 65), and it is
 * stored in IndexedDB as the key of its comments and saved marks (105). Any
 * part of the query can be a credential (a pre-signed URL, a private
 * GitLab file, a `?t=` of some host), so the key keeps the origin and the
 * path only (decision 120).
 */

const url = (address: string): DocumentSource => ({ kind: "url", url: address, trusted: true });

describe("the key of a ?src= document", () => {
  test("keeps the origin and the path and drops the query, the fragment and any user info", () => {
    expect(
      sourceKey(
        url("https://user:pw@docs.example/team/plan.md?t=abc123&X-Amz-Date=1#access_token=x"),
      ),
    ).toBe("url:https://docs.example/team/plan.md");
  });

  test("a query that looks harmless goes too: nothing in it is a name the reader needs", () => {
    expect(sourceKey(url("https://docs.example/plan.md?ref=main&raw=1"))).toBe(
      "url:https://docs.example/plan.md",
    );
  });

  test("the same file with another token is the same document, so its comments stay", () => {
    expect(sourceKey(url("https://docs.example/plan.md?token=one"))).toBe(
      sourceKey(url("https://docs.example/plan.md?token=two")),
    );
  });

  test("an address that does not parse keeps no query either", () => {
    expect(sourceKey(url("not a url?token=x"))).toBe("url:not a url");
  });
});

describe("the key before decision 120, read once to move what it holds", () => {
  test("is the address with only its access parameters and fragment removed", () => {
    expect(legacySourceKey(url("https://docs.example/plan.md?ref=main&token=x#h"))).toBe(
      "url:https://docs.example/plan.md?ref=main",
    );
  });

  test("is null when it equals the new key, or the source is not a ?src= link", () => {
    expect(legacySourceKey(url("https://docs.example/plan.md"))).toBeNull();
    expect(legacySourceKey(url("https://docs.example/plan.md?token=x"))).toBeNull();
    expect(legacySourceKey({ kind: "file", name: "plan.md" })).toBeNull();
  });
});
