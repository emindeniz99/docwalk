import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { DocumentSource } from "../inputs/types";
import { readFragment } from "./fragment";
import { LONG_LINK_WARNING, TOO_LONG_MESSAGE } from "./link";
import { PRIVACY_NOTE, ShareDialog } from "./ShareDialog";
import { FRAGMENT_MAX_CHARS, FRAGMENT_WARN_CHARS } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "https://docwalk.example/app/";
let root: Root | null = null;
const onOpenChange = vi.fn<(open: boolean) => void>();

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  onOpenChange.mockReset();
});

async function open(markdown: string, source: DocumentSource = { kind: "paste" }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(h(ShareDialog, { isOpen: true, onOpenChange, source, markdown, base: BASE })),
  );
  await vi.waitFor(() => {
    if (document.querySelector(".docwalk-share-dialog p")?.textContent?.startsWith("Preparing"))
      throw new Error("still building");
  });
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const input = () => dialog().querySelector<HTMLInputElement>("input")!;
const copyButton = () =>
  [...dialog().querySelectorAll("button")].find((b) => b.textContent?.includes("Copy link"));
const status = () => dialog().querySelector('[role="status"]')!.textContent;

/** Text deflate cannot shrink, to reach the length thresholds (mulberry32). */
function incompressible(chars: number): string {
  let seed = 11;
  let out = "";
  while (out.length < chars) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out += String.fromCharCode(0x21 + (((t ^ (t >>> 14)) >>> 0) % 94));
  }
  return out;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as Clipboard);
}

describe("share dialog", () => {
  test("is a named dialog whose controls are 44px targets, for screen readers and touch", async () => {
    await open("# Hi");
    expect(dialog().getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dialog().getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Share this document",
    );
    for (const button of dialog().querySelectorAll("button")) {
      const box = button.getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });

  test("shows a pasted document's fragment link with the privacy note", async () => {
    await open("# Pasted");
    expect(await readFragment(new URL(input().value).hash)).toBe("# Pasted");
    expect(dialog().textContent).toContain(PRIVACY_NOTE());
  });

  test("a repo document shows its source link and no privacy note, since nothing is in the link", async () => {
    await open("# Repo", { kind: "repo", repo: "acme/docs", path: "README.md", ref: null });
    expect(input().value).toBe(`${BASE}?repo=acme%2Fdocs&path=README.md`);
    expect(dialog().textContent).not.toContain(PRIVACY_NOTE());
  });

  test("Copy puts the link on the clipboard and says so", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    stubClipboard(writeText);
    await open("# Copy me");
    await userEvent.click(copyButton()!);
    expect(writeText).toHaveBeenCalledWith(input().value);
    await vi.waitFor(() => expect(status()).toBe("Link copied."));
  });

  test("when the clipboard is blocked, the link is selected so Ctrl+C still copies it", async () => {
    stubClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    await open("# Blocked");
    await userEvent.click(copyButton()!);
    await vi.waitFor(() => expect(status()).toContain("press Ctrl+C"));
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(input().value.length);
  });

  test("a long link carries the warning, and can still be copied", async () => {
    await open(incompressible(FRAGMENT_WARN_CHARS));
    expect(dialog().textContent).toContain(LONG_LINK_WARNING());
    expect(copyButton()).toBeDefined();
  });

  test("a document too long for a link shows why and offers nothing to copy", async () => {
    await open(incompressible(FRAGMENT_MAX_CHARS));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(TOO_LONG_MESSAGE());
    expect(copyButton()).toBeUndefined();
    expect(dialog().querySelector("input")).toBeNull();
  });

  test("Escape closes it, like every other dialog", async () => {
    await open("# Hi");
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
