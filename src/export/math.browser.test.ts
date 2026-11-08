import { describe, expect, test } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { MATH_CLASSES, mathAttributeAllowed } from "../render/mathAllow";
// Loads Temml's stylesheet into this page, as the first formula does in the app.
import { buildMath } from "../render/mathBuild";
import { exportHtml } from "./html";
import type { ExportSlide } from "./types";

/**
 * Decision 101, rule 5. The exports sanitize the live slide again with
 * DOMPurify, so a formula must survive that pass as MathML, and the pass
 * must hold MathML to the lists the builder used: the live slide is the
 * page's DOM, and whatever reaches it reaches the file.
 *
 * A file of its own: Temml's stylesheet, once loaded, is part of every
 * export's CSS, which the other export tests do not expect.
 */

const MATHML = "http://www.w3.org/1998/Math/MathML";
const HTML = "http://www.w3.org/1999/xhtml";

/** A slide shaped like the deck's, holding the MathML the deck draws, inline and display. */
function formulaSlide(): ExportSlide {
  const section = document.createElement("section");
  section.dataset["docwalkId"] = "f";
  section.dataset["page"] = "1";
  const slide = document.createElement("div");
  slide.className = "docwalk-slide";
  const body = document.createElement("div");
  body.className = "docwalk-slide-body";
  const title = document.createElement("h2");
  title.textContent = "Formulas";
  const line = document.createElement("p");
  line.append("Ratio ", buildMath("\\frac{a}{b}", false)!, " here.");
  const host = document.createElement("div");
  host.className = "docwalk-math-display";
  host.append(buildMath("\\sqrt{x^2 + y^2} \\cancel{z}", true)!);
  body.append(title, line, host);
  slide.append(body);
  section.append(slide);
  return { address: "f/1", title: "Formulas", element: section };
}

async function parseExport(slide: ExportSlide): Promise<{ text: string; doc: Document }> {
  const blob = await exportHtml({
    title: "Math",
    slides: [slide],
    size: { width: 1280, height: 720 },
  });
  const text = await blob.text();
  return { text, doc: new DOMParser().parseFromString(text, "text/html") };
}

/** Attributes on MathML elements that the builder's lists do not allow, as `name on <tag>`. */
function unlisted(doc: Document): string[] {
  return [...doc.getElementsByTagNameNS(MATHML, "*")].flatMap((el) =>
    [...el.attributes]
      .filter((a) =>
        a.name === "class"
          ? a.value.split(/\s+/).some((c) => !MATH_CLASSES.has(c))
          : !mathAttributeAllowed(a.name, a.value),
      )
      .map((a) => `${a.name}="${a.value}" on <${el.localName}>`),
  );
}

const make = (name: string, ns = MATHML) => document.createElementNS(ns, name);

describe("formulas in the exports", () => {
  test("stay MathML, inline and display", async () => {
    const { doc } = await parseExport(formulaSlide());
    const maths = [...doc.getElementsByTagNameNS(MATHML, "math")];
    expect(maths).toHaveLength(2);
    expect(maths[0]!.closest("p")?.textContent).toBe("Ratio ab here.");
    expect(maths[0]!.querySelector("mfrac")?.namespaceURI).toBe(MATHML);
    expect(maths[1]!.getAttribute("display")).toBe("block");
    expect(maths[1]!.parentElement?.className).toBe("docwalk-math-display");
    expect(maths[1]!.querySelector("msqrt msup")).not.toBeNull();
    expect(maths[1]!.querySelector("menclose")?.getAttribute("notation")).toBeTruthy();
    expect(unlisted(doc)).toEqual([]);
  });

  test("carry Temml's rules in the file's own CSS, with no URL outside data:", async () => {
    const { doc, text } = await parseExport(formulaSlide());
    const css = doc.querySelector("style")?.textContent ?? "";
    expect(css).toContain(".tml-cancel");
    // Temml's stylesheet holds SVG as data: URLs, whose xmlns is the only http string.
    const outsideData = text.replace(/url\("data:[^"]*"\)/g, "");
    expect(outsideData.match(/https?:\/\/[^\s"')<]*/g) ?? []).toEqual([]);
  });

  test("drop what a tampered slide put into its MathML", async () => {
    // DOMPurify's own MathML profile allows `href`, `id` and `xlink:href`;
    // the hook must not.
    const slide = formulaSlide();
    const math = slide.element.querySelector("math")!;
    math.setAttribute("onclick", "window.dwXssRan=1");
    math.setAttribute("style", "background: url(https://tracker.example/m.png)");
    math.setAttribute("href", "https://tracker.example/m");
    math.setAttribute("id", "user-content-ratio");
    math.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "javascript:alert(1)");
    math.setAttribute("class", "docwalk-diagram tml-vec present");
    math.setAttribute("mathcolor", "red;background:url(https://tracker.example/c.png)");
    const frac = math.querySelector("mfrac")!;
    frac.setAttribute("mathbackground", "url(https://tracker.example/b.png)");
    frac.setAttribute("data-x", "1");
    const action = make("maction");
    action.setAttribute("actiontype", "statusline");
    action.append(make("mtext"));
    const semantics = make("semantics");
    const annotation = make("annotation-xml");
    annotation.setAttribute("encoding", "text/html");
    // No src: an <img> made in this page would load at once, before any export.
    const image = make("img", HTML);
    image.setAttribute("alt", "pixel");
    annotation.append(image);
    semantics.append(annotation);
    const glyph = make("mglyph");
    glyph.setAttribute("src", "https://tracker.example/glyph.png");
    const link = make("a", HTML);
    link.setAttribute("href", "https://tracker.example/link");
    link.textContent = "link";
    const script = make("script", HTML);
    script.textContent = "window.dwXssRan=1";
    math.append(action, semantics, glyph, link, script);

    const { doc, text } = await parseExport(slide);
    expect(unlisted(doc)).toEqual([]);
    const ratio = doc.getElementsByTagNameNS(MATHML, "math")[0]!;
    expect(ratio.querySelector("mfrac")).not.toBeNull();
    expect(ratio.getAttribute("class")).toBe("tml-vec");
    const left = ratio.querySelectorAll(
      "maction, semantics, annotation-xml, mglyph, a, img, script",
    );
    expect(left).toHaveLength(0);
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    expect(text).not.toContain("tracker.example");
    expect(text).not.toContain("javascript:");
  });
});
