import { afterEach, describe, expect, test } from "vitest";
import { slideFingerprint, slideFingerprints } from "./markKeys";

/**
 * Saved marks keep the fingerprint of the slide text they were drawn on
 * (decision 105), so the fingerprint must leave out what changes with the UI
 * language: a language switch keeps the marks. And it must not change for a
 * slide it already named, or every mark saved before would wait for a text
 * that never comes back.
 */

afterEach(() => {
  document.body.replaceChildren();
});

/** A page as the deck builds it: `<section>` around a `.docwalk-slide-body`. */
function page(body: string): HTMLElement {
  const section = document.createElement("section");
  section.dataset["docwalkId"] = "intro";
  section.dataset["page"] = "1";
  section.innerHTML = `<div class="docwalk-slide-body">${body}</div>`;
  document.body.append(section);
  return section;
}

/** A diagram host whose Mermaid source failed, as `renderOne` leaves it, with its note in `note`. */
const failedDiagram = (note: string) =>
  `<div class="docwalk-diagram docwalk-diagram-error"><p class="docwalk-diagnostic">${note}</p><pre>graph TD; A--</pre></div>`;

describe("the fingerprint of a slide's text", () => {
  test("a failed diagram's note in English and in Turkish gives one fingerprint, so a language switch keeps the marks", () => {
    const english = slideFingerprint(
      page(`<h2>Plan</h2>${failedDiagram("This diagram could not be rendered: Parse error")}`),
    );
    const turkish = slideFingerprint(
      page(`<h2>Plan</h2>${failedDiagram("Bu diyagram çizilemedi: Parse error")}`),
    );
    expect(turkish).toBe(english);
  });

  test("the diagram's source still counts: another failed source is another text", () => {
    const one = slideFingerprint(page(`<h2>Plan</h2>${failedDiagram("note")}`));
    const other = slideFingerprint(
      page(`<h2>Plan</h2>${failedDiagram("note").replace("graph TD; A--", "graph LR; B--")}`),
    );
    expect(other).not.toBe(one);
  });

  test("a slide without a diagnostic keeps the fingerprint it had, so marks saved before still come back", () => {
    // Pinned from the selector before decision 132: "IntroAlpha beta." under 32-bit FNV-1a.
    const section = page(
      `<h2>Intro</h2><p>Alpha <code>beta</code>.</p><span class="docwalk-continued"> · continued</span><style>.x{}</style>`,
    );
    expect(slideFingerprint(section)).toBe("c799bb9b");
    expect(slideFingerprints(document.body)).toEqual(new Map([["intro/1", "c799bb9b"]]));
  });
});
