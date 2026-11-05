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
    document.documentElement.setAttribute("data-theme", "light");
    const box = mount("Plain (round) [square] {curly} text");
    await painted();
    const spans = [...box.querySelectorAll<HTMLElement>(".view-line span span")];
    expect(spans.length).toBeGreaterThan(0);
    const colours = new Set(spans.map((s) => getComputedStyle(s).color));
    expect([...colours]).toEqual([resolved("--fg")]);
  });
});
