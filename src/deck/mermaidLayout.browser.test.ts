import { afterEach, expect, test } from "vitest";
import { renderDiagrams } from "./mermaid";

afterEach(() => {
  document.body.replaceChildren();
});

test("a plain flowchart is laid out with dagre and never downloads ELK", async () => {
  // Mermaid 12 defaults to ELK: a 447 kB gzip chunk, more than the whole app
  // shell, fetched by the first flowchart or state diagram. Dagre is 17 kB and
  // fits the sample's diagrams to a 16:9 slide as well or better (decision 26).
  const body = document.createElement("div");
  body.innerHTML = `<pre><code class="language-mermaid"></code></pre>`;
  body.querySelector("code")!.textContent = "flowchart LR\n  a --> b\n  b --> c";
  document.body.append(body);
  const [result] = await renderDiagrams(body);
  expect(result).toEqual({ ok: true });
  const chunks = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name.replace(/^.*\//, ""))
    .filter((name) => /^(?:elk|dagre)-/.test(name));
  expect(chunks.some((name) => name.startsWith("dagre-"))).toBe(true);
  expect(chunks.filter((name) => name.startsWith("elk-"))).toEqual([]);
});
