import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { highlightCode } from "../render/highlight";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { ChannelFactory } from "./bridge";
import { PresenterView } from "./PresenterView";

// A file of its own: the Shiki chunk must still be loading when the build is
// stopped, and a test file gets fresh modules, so nothing has loaded it yet.

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// The window shares its main thread with the audience deck in WebKit:
// colouring the code of a document it no longer shows is work taken from the
// deck and from the build that replaced it.
test("a stopped preview build colours no code once the grammars arrive", async () => {
  const markdown = Array.from(
    { length: 6 },
    (_, i) => `## Part ${i + 1}\n\n\`\`\`ts\nconst part = ${i + 1};\n\`\`\`\n`,
  ).join("\n");
  const addresses = sectionize(parseMarkdown(markdown), "auto").sections.map((s) => `${s.id}/1`);

  // Every <code> the highlighter fills, but the probe block below.
  const probe = document.createElement("code");
  const coloured: Element[] = [];
  const replaceChildren = Element.prototype.replaceChildren;
  vi.spyOn(Element.prototype, "replaceChildren").mockImplementation(function (
    this: Element,
    ...nodes
  ) {
    if (this.tagName === "CODE" && this !== probe) coloured.push(this);
    return replaceChildren.apply(this, nodes);
  });

  const listeners: ((data: unknown) => void)[] = [];
  const channel: ChannelFactory = () => ({
    postMessage: () => {},
    listen: (listener) => listeners.push(listener),
    close: () => {},
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(h(PresenterView, { channel }));
  await expect.poll(() => listeners.length).toBeGreaterThan(0);

  // The build measures an empty slide body before anything else, in a box
  // on <body>. Close the window right then: the build has asked for the
  // grammars and is waiting for them.
  const started = new Promise<void>((resolve) => {
    const observer = new MutationObserver((records) => {
      const added = records.flatMap((r) => [...r.addedNodes]);
      if (!added.some((n) => n instanceof HTMLElement && n.matches(".docwalk-measure"))) return;
      observer.disconnect();
      root.unmount();
      resolve();
    });
    observer.observe(document.body, { childList: true });
  });
  for (const listener of listeners) {
    listener({
      type: "state",
      markdown,
      level: "auto",
      current: addresses[0],
      addresses,
      startedAt: 0,
    });
  }
  await started;
  expect(coloured).toEqual([]);

  // The same grammar, through the same loader: once this block is coloured,
  // the stopped build has its grammars too.
  const pre = document.createElement("pre");
  probe.className = "language-ts";
  probe.textContent = "const probe = 1;";
  pre.append(probe);
  await highlightCode(pre);
  expect(probe.querySelector("[class^='dw-code-']")).not.toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(coloured).toEqual([]);
}, 30_000);
