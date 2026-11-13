import { editor as monaco } from "monaco-editor/editor";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, test } from "vitest";
import "virtual:docwalk-tokens.css";
import "../../styles.css";
import { MonacoEditor } from "./MonacoEditor";

/**
 * What only Monaco needs on top of the shared contract tests: its colours
 * come from a theme object rather than CSS, so following the app's light and
 * dark tokens and staying inside the palette must be checked in a browser.
 */

let root: Root | null = null;
let frame: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  frame?.remove();
  root = frame = null;
  document.documentElement.removeAttribute("data-theme");
});

function mount(value: string) {
  frame = document.createElement("div");
  Object.assign(frame.style, { display: "flex", width: "600px", height: "240px" });
  document.body.append(frame);
  root = createRoot(frame);
  flushSync(() =>
    root!.render(createElement(MonacoEditor, { value, onChange: () => {}, label: "Source" })),
  );
  return frame;
}

/** A semantic variable as the browser resolves it (rgb()), for comparison with computed styles. */
function resolved(variable: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

describe("MonacoEditor theme", () => {
  test("follows the app between light and dark, from the same tokens as the rest of the UI", async () => {
    // A light editor inside a dark app (or the reverse) is the first thing a
    // viewer would notice after switching editors.
    document.documentElement.setAttribute("data-theme", "light");
    const box = mount("# Title\n");
    await painted();
    const background = () => getComputedStyle(box.querySelector(".monaco-editor")!).backgroundColor;
    expect(background()).toBe(resolved("--surface"));
    const light = background();

    document.documentElement.setAttribute("data-theme", "dark");
    await painted();
    expect(background()).toBe(resolved("--surface"));
    expect(background()).not.toBe(light);
  });

  test("brackets keep the text colour: no rainbow colours outside the design tokens", async () => {
    // Monaco colours bracket pairs by default; DESIGN.md allows no colours
    // beyond its tokens, and the editor option alone does not turn it off.
    // Round brackets in prose: Markdown paints `[…]` and `{…}` as link-coloured
    // strings, and Monaco never pair-colours brackets inside a string token.
    // Three levels deep, so each of the three rainbow colours would show.
    document.documentElement.setAttribute("data-theme", "light");
    const box = mount("Plain (round ((nested)) text) here");
    // Monaco loads Markdown's bracket pairs and grammar in one lazy import,
    // some frames after mounting; until then no bracket is coloured, on or
    // off. colorize() resolves once the grammar is in, and the pairs are set
    // before it, so the next paint shows any bracket colours. (Painting the
    // grammar's tokens waits for idle time, which a busy test page can
    // withhold for seconds; bracket colours do not wait for it.)
    await monaco.colorize("", "markdown", {});
    await painted();
    const spans = [...box.querySelectorAll<HTMLElement>(".view-line span span")];
    expect(spans.length).toBeGreaterThan(0);
    const colours = new Set(spans.map((s) => getComputedStyle(s).color));
    expect([...colours]).toEqual([resolved("--fg")]);
  });

  test.each(["light", "dark"])(
    "%s: code uses the editor's code colour and links the link colour (decision 131)",
    async (theme) => {
      // Code in the link colour, the brand's red, made a document with code
      // look as if something were wrong. axe does not judge syntax colours.
      document.documentElement.setAttribute("data-theme", theme);
      const box = mount(
        "Some `inline` code and [a link](https://example.com).\n\n```\nfenced\n```\n",
      );
      await monaco.colorize("", "markdown", {});
      const colourOf = (text: string) => {
        const span = [...box.querySelectorAll<HTMLElement>(".view-line span span")].find(
          (s) => s.textContent === text,
        );
        return span ? getComputedStyle(span).color : null;
      };
      expect(resolved("--editor-code")).not.toBe(resolved("--link"));
      // Monaco paints the grammar's tokens in idle time, which can take a while.
      await expect
        .poll(() => colourOf("`inline`"), { timeout: 10_000 })
        .toBe(resolved("--editor-code"));
      expect(colourOf("fenced")).toBe(resolved("--editor-code"));
      expect(colourOf("```")).toBe(resolved("--editor-code"));
      expect(colourOf("](https://example.com)")).toBe(resolved("--link"));
    },
  );
});
