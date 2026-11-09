import { afterEach, describe, expect, test } from "vitest";
import { renameIds } from "./renameIds";

afterEach(() => document.body.replaceChildren());

/**
 * A page as the deck renders it, cut down: a heading, a footnote reference
 * and its note, a link to another slide, and a Mermaid-like SVG whose style
 * selects by the root's id and whose path reaches its marker by id.
 */
function page(): HTMLElement {
  const el = document.createElement("section");
  el.innerHTML = `
    <h2 id="user-content-a">A</h2>
    <p><a id="user-content-fnref-1" href="#user-content-fn-1" aria-describedby="footnote-label  other">1</a>
      <a href="#elsewhere">far</a></p>
    <svg id="docwalk-mermaid-1" viewBox="0 0 10 10">
      <style>#docwalk-mermaid-1 .n { fill: rgb(1, 2, 3); }
        #docwalk-mermaid-10 .n { stroke: rgb(9, 9, 9); }
        #docwalk-mermaid-1 .m { marker-start: url("#docwalk-mermaid-1_end"); }</style>
      <defs><marker id="docwalk-mermaid-1_end"></marker></defs>
      <path class="n m" d="M0 0" marker-end="url(#docwalk-mermaid-1_end)"
        style="filter: url('#docwalk-mermaid-1_end')"></path>
      <use href="#docwalk-mermaid-1_end"></use>
    </svg>
    <h3 id="footnote-label">Footnotes</h3>
    <ol><li id="user-content-fn-1">The note.</li></ol>`;
  return el;
}

describe("renameIds", () => {
  test("every id gets the prefix and each reference inside the copy follows it", () => {
    // The overview shows the copy beside the slide: an id left as it was
    // repeats, and a reference left behind points out of the copy.
    const slide = page();
    const copy = slide.cloneNode(true) as HTMLElement;
    renameIds(copy, "t1-");
    document.body.append(slide, copy);

    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...copy.querySelectorAll("[id]")].every((el) => el.id.startsWith("t1-"))).toBe(true);

    const ref = copy.querySelector("p a")!;
    expect(ref.getAttribute("href")).toBe("#t1-user-content-fn-1");
    expect(ref.getAttribute("aria-describedby")).toBe("t1-footnote-label  other");
    // An id the copy does not hold still names the slide's element.
    expect(copy.querySelector('a[href="#elsewhere"]')).not.toBeNull();

    const path = copy.querySelector("path")!;
    expect(path.getAttribute("marker-end")).toBe("url(#t1-docwalk-mermaid-1_end)");
    expect(path.getAttribute("style")).toBe("filter: url('#t1-docwalk-mermaid-1_end')");
    expect(copy.querySelector("use")!.getAttribute("href")).toBe("#t1-docwalk-mermaid-1_end");
  });

  test("the copy's style selects its own renamed root, and only whole ids are renamed", () => {
    // Mermaid scopes every rule by the SVG root's id. A rule that still named
    // the old id would style the slide's diagram and leave the copy black.
    const copy = page();
    renameIds(copy, "t1-");
    document.body.append(copy);
    const path = copy.querySelector("path")!;
    expect(getComputedStyle(path).fill).toBe("rgb(1, 2, 3)");
    expect(getComputedStyle(path).markerStart).toBe('url("#t1-docwalk-mermaid-1_end")');
    const css = copy.querySelector("style")!.textContent ?? "";
    // docwalk-mermaid-10 begins with the renamed docwalk-mermaid-1 but is another id.
    expect(css).toContain("#docwalk-mermaid-10 .n");
    expect(css).not.toMatch(/#docwalk-mermaid-1[\s_]/);
  });
});
