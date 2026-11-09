import { describe, expect, test } from "vitest";
import { parseMarkdown } from "../sectioning/sectionize";
import { nodesToHtml } from "./toHtml";

const render = (markdown: string) => nodesToHtml(parseMarkdown(markdown).children);

/**
 * Math reaches the page in two steps: the sanitized HTML carries the formula
 * as text inside `<code class="language-math">`, and `renderMath` (browser
 * test) turns it into MathML from the parsed expression. These tests hold the
 * first step: the TeX survives both sanitizers as text, in the shape the
 * second step looks for, and an author's own MathML does not.
 */
describe("math in the sanitized HTML", () => {
  test("inline math is a code element holding the TeX as text", () => {
    expect(render("Energy $E = mc^2$ here.")).toBe(
      '<p>Energy <code class="language-math">E = mc^2</code> here.</p>',
    );
  });

  test("display math is a pre holding that code element", () => {
    expect(render("$$\n\\frac{a}{b}\n$$\n")).toBe(
      '<pre><code class="language-math">\\frac{a}{b}</code></pre>',
    );
  });

  test("a math fence gets the same shape as $$ display math", () => {
    expect(render("```math\n\\frac{a}{b}\n```\n")).toBe(
      '<pre><code class="language-math">\\frac{a}{b}\n</code></pre>',
    );
  });

  test("angle brackets in a formula are escaped, never markup", () => {
    // `a < b` and `x<script>` must reach the DOM step as text.
    const html = render("Both $a < b$ and $x<script>alert(1)</script>$ appear.");
    expect(html).not.toContain("<script");
    expect(html).toContain("a &#x3C; b");
  });

  test("a dollar amount is not wrapped", () => {
    expect(render("It costs $5 and $10.")).toBe("<p>It costs $5 and $10.</p>");
  });

  test("an author's own <math> is still dropped with its contents (decision 60)", () => {
    // Only a parsed expression produces MathML; written markup never does.
    const html = render(
      '<math><mi>x</mi><mo href="https://tracker.example">+</mo></math>\n\nAfter',
    );
    expect(html).not.toContain("math");
    expect(html).not.toContain("tracker");
    expect(html).toContain("After");
  });

  test("a code span holding TeX stays code", () => {
    expect(render("Type `$x$` to start.")).toBe("<p>Type <code>$x$</code> to start.</p>");
  });
});
