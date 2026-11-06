import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { DeckController } from "../deck/controller";
import { Deck } from "../deck/Deck";
import { renderDiagrams } from "../deck/mermaid";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { BLOCKED_IMAGE_CLASS } from "./toHtml";

/**
 * Rule 8 and decision 33: opening a document must not tell another host
 * that someone is reading it. A remote image is a request the viewer did not
 * ask for, carrying their IP address and the time. These tests watch the
 * real network (Resource Timing records every image request, even one whose
 * host never resolves) instead of checking attributes, because the two
 * leaks found in review both had the right attributes at the moment the
 * old tests looked: reveal.js and Mermaid issued the request later.
 */

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A host no other test uses, so requests left over from another test never count here. */
function trackerHost(): string {
  return `t${crypto.randomUUID().slice(0, 8)}.invalid`;
}

/** Every request the page has made to `host` so far. */
function requestsTo(host: string): string[] {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes(host));
}

/** Mount the real Deck (reveal.js, pagination, click-to-load) as the app does. */
async function mountDeck(markdown: string): Promise<DeckController> {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(container);
  root = createRoot(container);
  let controller: DeckController | null = null;
  root.render(
    h(Deck, {
      plan: sectionize(parseMarkdown(markdown), "auto"),
      onReady: (c: DeckController | null) => {
        if (c) controller = c;
      },
    }),
  );
  await expect.poll(() => controller, { timeout: 20_000, interval: 10 }).not.toBeNull();
  return controller as unknown as DeckController;
}

describe("slide mode never loads a blocked image by itself", () => {
  test("stepping through every slide requests nothing until an image is clicked", async () => {
    // reveal.js lazy-loads `img[data-src]` on every slide within its view
    // distance. The gate used to park the blocked URL in `data-src`, so
    // opening a deck fetched the first slides' images with no click at all.
    const host = trackerHost();
    const slides = [1, 2, 3, 4, 5]
      .map((n) => `## Slide ${n}\n\n![chart ${n}](https://${host}/slide${n}.png)\n`)
      .join("\n");
    const deck = await mountDeck(`# Tracked\n\n${slides}`);
    for (let i = 0; i < deck.slides().length; i++) {
      deck.next();
      await sleep(50);
    }
    await sleep(300);
    expect(requestsTo(host)).toEqual([]);

    // The viewer's click is the consent: exactly that image loads.
    const img = document.querySelector<HTMLImageElement>(
      `.reveal .slides section.present img.${BLOCKED_IMAGE_CLASS}`,
    );
    expect(img).not.toBeNull();
    img!.click();
    await expect
      .poll(() => requestsTo(host), { timeout: 5_000 })
      .toEqual([`https://${host}/slide5.png`]);
  });
});

describe("a diagram never fetches an image (decision 26)", () => {
  // Mermaid reads `@{ … }` shape data as YAML and preloads `img` with
  // `new Image()` before any SVG exists for DOMPurify to clean; a sequence
  // actor's `icon` property becomes an `<image>` in the live page while
  // Mermaid lays it out. The old pre-pass rewrote only `img: "…"` with a
  // quoted value, so every other YAML spelling went through.
  const forms: Record<string, (host: string) => string> = {
    "plain scalar": (host) =>
      `flowchart LR\n  A@{ img: https://${host}/plain.png, label: "A", h: 60 } --> B`,
    "double-quoted key": (host) => `flowchart LR\n  A@{ "img": "https://${host}/dq.png" } --> B`,
    "single-quoted key": (host) => `flowchart LR\n  A@{ 'img': 'https://${host}/sq.png' } --> B`,
    "multi-line block": (host) =>
      `flowchart LR\n  A@{\n    img: https://${host}/ml.png\n    label: A\n  }\n  A --> B`,
    "hex-escaped key": (host) => `flowchart LR\n  A@{ "\\x69mg": "https://${host}/hex.png" } --> B`,
    "unicode-escaped key": (host) =>
      `flowchart LR\n  A@{ "\\u0069mg": "https://${host}/uni.png" } --> B`,
    "quoted value": (host) => `flowchart LR\n  A@{ img: "https://${host}/q.png" } --> B`,
    "sequence actor icon": (host) =>
      `sequenceDiagram\n  participant A\n  properties A: {"icon": "https://${host}/icon.png"}\n  A->>A: hi`,
  };

  for (const [name, diagram] of Object.entries(forms)) {
    test(`${name}: no request, and the diagram says why it is not shown`, async () => {
      const host = trackerHost();
      const body = document.createElement("div");
      body.innerHTML = `<pre><code class="language-mermaid"></code></pre>`;
      body.querySelector("code")!.textContent = diagram(host);
      document.body.append(body);
      const [result] = await renderDiagrams(body);
      await sleep(300);
      expect(requestsTo(host)).toEqual([]);
      // Refused visibly (rule 3), not silently drawn without its image.
      expect(result?.ok).toBe(false);
      expect(body.querySelector(".docwalk-diagnostic")?.textContent).toMatch(/another site/);
    });
  }

  test("shape data without an image still renders", async () => {
    // The gate reads what Mermaid parsed, so ordinary shapes are untouched.
    const body = document.createElement("div");
    body.innerHTML = `<pre><code class="language-mermaid"></code></pre>`;
    body.querySelector("code")!.textContent =
      'flowchart LR\n  A@{ shape: cyl, label: "Ledger" } --> B@{ shape: doc }';
    document.body.append(body);
    const [result] = await renderDiagrams(body);
    expect(result).toEqual({ ok: true });
    expect(body.querySelector("svg")).not.toBeNull();
  });
});
