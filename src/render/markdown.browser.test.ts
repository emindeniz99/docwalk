import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { DeckController } from "../deck/controller";
import { Deck } from "../deck/Deck";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { DocumentView } from "../shell/DocumentView";

/**
 * Markdown fidelity in the assembled deck and document view: GitHub alerts,
 * footnotes, heading anchors and fallback addresses, in a real browser with
 * reveal.js, pagination and the app's CSS.
 */

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

function pane(size = { width: 1280, height: 800 }): HTMLElement {
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${size.width}px`,
    height: `${size.height}px`,
    overflow: "auto",
  });
  document.body.append(container);
  root = createRoot(container);
  return container;
}

/** The real Deck, as App mounts it; resolves with its controller once built. */
async function mountDeck(markdown: string): Promise<DeckController> {
  let controller: DeckController | null = null;
  const onReady = (c: DeckController | null) => {
    controller = c;
  };
  pane();
  root!.render(h(Deck, { plan: sectionize(parseMarkdown(markdown), "auto"), onReady }));
  await expect.poll(() => controller, { timeout: 20_000, interval: 10 }).not.toBeNull();
  return controller!;
}

async function mountDocument(markdown: string): Promise<HTMLElement> {
  const container = pane();
  root!.render(h(DocumentView, { root: parseMarkdown(markdown) }));
  await expect.poll(() => container.querySelector(".docwalk-document > *")).not.toBeNull();
  return container.querySelector<HTMLElement>(".docwalk-document")!;
}

const present = () => document.querySelector<HTMLElement>(".reveal .slides section.present")!;

/** The computed colour a token resolves to, for comparing against computed styles. */
function tokenColor(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(--dw-color-${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

const FOOTNOTED = [
  "## One",
  "",
  "Plain.",
  "",
  "## Two",
  "",
  "A claim.[^src] Another.[^more]",
  "",
  "## Three",
  "",
  "The end.",
  "",
  "[^src]: The source.",
  "[^more]: More detail.",
  "",
].join("\n");

describe("footnotes in the deck", () => {
  test("a footnote shows on the slide that references it, not on the last slide", async () => {
    // A presenter reading "A claim.¹" must be able to point at ¹'s text on
    // the same slide; before, the definitions sat on whichever slide came last.
    const deck = await mountDeck(FOOTNOTED);
    expect(deck.slides().map((s) => s.address)).toEqual(["one/1", "two/1", "three/1"]);
    deck.goTo("two");
    await expect.poll(() => present().dataset["docwalkId"]).toBe("two");
    const notes = present().querySelector(".footnotes");
    expect(notes?.textContent).toContain("The source.");
    expect(notes?.textContent).toContain("More detail.");
    deck.goTo("three");
    await expect.poll(() => present().dataset["docwalkId"]).toBe("three");
    expect(present().textContent).not.toContain("The source.");
  });

  test("the footnote label is hidden as on GitHub, and screen readers still get it", async () => {
    const deck = await mountDeck(FOOTNOTED);
    deck.goTo("two");
    await expect.poll(() => present().dataset["docwalkId"]).toBe("two");
    const label = present().querySelector<HTMLElement>(".footnotes h2")!;
    expect(label.textContent).toBe("Footnotes");
    expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    const ref = present().querySelector("a[data-footnote-ref]")!;
    expect(document.getElementById(ref.getAttribute("aria-describedby")!)).toBe(label);
  });

  test("following a footnote and its back link moves focus on the same slide, never the slide", async () => {
    const deck = await mountDeck(FOOTNOTED);
    deck.goTo("two");
    await expect.poll(() => present().dataset["docwalkId"]).toBe("two");
    const hashBefore = location.hash;
    const ref = present().querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!;
    await userEvent.click(ref);
    expect(document.activeElement?.id).toBe("user-content-two-fn-src");
    expect(deck.current()?.address).toBe("two/1");
    // The browser's own jump would have scrolled reveal's stage and set the hash.
    expect(location.hash).toBe(hashBefore);
    await userEvent.click(present().querySelector<HTMLAnchorElement>(".data-footnote-backref")!);
    expect(document.activeElement).toBe(ref);
  });

  test("a footnote list or a raw <section> never becomes a reveal.js vertical slide", async () => {
    // reveal.js reads every <section> inside a slide as a vertical sub-slide.
    // GitHub's footnote list is a <section>: the slide became a stack whose
    // background layer covered the text, so no link on it took a click.
    const deck = await mountDeck(
      "## A\n\nClaim.[^n]\n\n<section>Raw section text</section>\n\n## B\n\nb\n\n[^n]: Note.\n",
    );
    expect(deck.slides().map((s) => s.address)).toEqual(["a/1", "b/1"]);
    expect(document.querySelector(".reveal .slides section section")).toBeNull();
    expect(document.querySelector(".reveal .slides section.stack")).toBeNull();
    const ref = present().querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!;
    const r = ref.getBoundingClientRect();
    expect(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)).toBe(ref);
    expect(present().textContent).toContain("Raw section text");
  });

  test("ids stay unique across the deck when several slides have footnotes", async () => {
    await mountDeck("## A\n\nx[^n]\n\n## B\n\ny[^n]\n\n[^n]: Shared note.\n");
    const ids = [...document.querySelectorAll(".reveal [id]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a long slide without a heading never gets 'Footnotes' as its continued title", async () => {
    // Pagination titled continuation pages with the first heading anywhere in
    // the slide, which for a heading-less slide was the hidden footnote label.
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.[^a]`).join("\n\n");
    const deck = await mountDeck(`${long}\n\n[^a]: The note.\n`);
    expect(deck.slides().length).toBeGreaterThan(1);
    const titles = [...document.querySelectorAll(".reveal .docwalk-part-title")].map(
      (el) => el.textContent,
    );
    expect(titles.filter((t) => t?.includes("Footnotes"))).toEqual([]);
  });
});

describe("heading anchors in the deck", () => {
  const LONG = [
    "## Intro",
    "",
    "See [the retry budget](#retry-budget).",
    "",
    "## Failure handling",
    "",
    ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i} about failures.\n`),
    "#### Retry budget",
    "",
    "Three retries, then give up.",
    "",
  ].join("\n");

  test("a link to an H4 opens the page that holds it, not slide 1", async () => {
    // GitHub readers share links to sub-headings (#retry-budget); before,
    // the deck did not know that id and stayed on the first slide.
    const deck = await mountDeck(LONG);
    const pages = deck.slides().filter((s) => s.sectionId === "failure-handling");
    expect(pages.length).toBeGreaterThan(1);
    expect(deck.goTo("retry-budget")).toBe(true);
    await expect.poll(() => present().querySelector("#user-content-retry-budget")).not.toBeNull();
    expect(deck.current()?.sectionId).toBe("failure-handling");
    expect(deck.current()?.page).toBeGreaterThan(1);
  });

  test("clicking an in-slide link to that heading goes there too", async () => {
    const deck = await mountDeck(LONG);
    await userEvent.click(present().querySelector<HTMLAnchorElement>('a[href="#retry-budget"]')!);
    await expect.poll(() => deck.current()?.sectionId).toBe("failure-handling");
    expect(present().querySelector("#user-content-retry-budget")).not.toBeNull();
  });

  test("anchors on a page that merged short sub-heading parts open that one page", async () => {
    // The deck track merges short parts after a split; the anchor fallback
    // must find each merged heading on the shared page, so a link and the
    // overview agree on one address.
    const short = "A short note.\n\n";
    const long = "A paragraph of explanation that takes some room.\n\n".repeat(14);
    const deck = await mountDeck(
      `# Doc\n\nx\n\n## Failure handling\n\nintro\n\n### Retries\n\n${short}### Timeouts\n\n${short}### Poison messages\n\n${long}### Alerts\n\n${short}### Dashboards\n\n${short}`,
    );
    const pages = deck.slides().filter((s) => s.sectionId === "failure-handling");
    const last = pages.at(-1)!.address;
    expect(deck.goTo("alerts")).toBe(true);
    await expect.poll(() => deck.current()?.address).toBe(last);
    deck.goTo("failure-handling");
    await expect.poll(() => deck.current()?.address).toBe(pages[0]!.address);
    expect(deck.goTo("dashboards")).toBe(true);
    await expect.poll(() => deck.current()?.address).toBe(last);
    expect(present().querySelector("#user-content-alerts")).not.toBeNull();
    expect(present().querySelector("#user-content-dashboards")).not.toBeNull();
    // Timeouts merged into the first page, with the slide heading.
    expect(deck.goTo("timeouts")).toBe(true);
    await expect.poll(() => deck.current()?.address).toBe(pages[0]!.address);
  });

  test("a link to a heading inside a quote opens the page that holds it (decision 107)", async () => {
    // Only headings at the top of the tree had anchors; this link stayed on slide 1.
    const deck = await mountDeck(
      [
        "## Intro",
        "",
        "See [the quoted rule](#quoted-rule).",
        "",
        "## Rules",
        "",
        ...Array.from({ length: 30 }, (_, i) => `Rule note ${i}.\n`),
        "> ### Quoted rule",
        ">",
        "> Keep it short.",
        "",
      ].join("\n"),
    );
    expect(deck.slides().filter((s) => s.sectionId === "rules").length).toBeGreaterThan(1);
    await userEvent.click(present().querySelector<HTMLAnchorElement>('a[href="#quoted-rule"]')!);
    await expect.poll(() => deck.current()?.sectionId).toBe("rules");
    expect(deck.current()?.page).toBeGreaterThan(1);
    expect(present().querySelector("blockquote #user-content-quoted-rule")).not.toBeNull();
  });

  test("an unknown anchor is still refused, so the URL sync falls back as before", async () => {
    const deck = await mountDeck(LONG);
    expect(deck.goTo("no-such-heading")).toBe(false);
  });

  test("an emoji-only heading gets an address that opens it", async () => {
    const deck = await mountDeck("## 🚀\n\nLaunch.\n\n## Next\n\nAfter.\n");
    expect(deck.slides().map((s) => s.address)).toEqual(["heading-1f680/1", "next/1"]);
    deck.goTo("next");
    expect(deck.goTo("heading-1f680/1")).toBe(true);
    await expect.poll(() => deck.current()?.address).toBe("heading-1f680/1");
  });
});

const ALERTS = ["note", "tip", "important", "warning", "caution"];
const ALERT_DOC = ALERTS.map((k) => `> [!${k.toUpperCase()}]\n> About ${k}.`).join("\n\n");

describe("GitHub alerts", () => {
  test("each alert on a slide gets GitHub's colour on its edge and title, in both themes", async () => {
    // The slide stays white in a dark theme, so the light set must stay too:
    // the dark set's lighter colours would fade on white.
    document.documentElement.dataset["theme"] = "dark";
    await mountDeck(`## Alerts\n\n${ALERT_DOC}\n`);
    const seen = ALERTS.map((kind) => {
      const alert = present().querySelector<HTMLElement>(`.markdown-alert-${kind}`)!;
      const title = alert.querySelector<HTMLElement>(".markdown-alert-title")!;
      return {
        kind,
        edge: getComputedStyle(alert).borderInlineStartColor,
        title: getComputedStyle(title).color,
        text: title.textContent,
        iconHidden: title.querySelector("svg")?.getAttribute("aria-hidden"),
      };
    });
    expect(seen).toEqual(
      ALERTS.map((kind) => ({
        kind,
        edge: tokenColor(`alert-${kind}`),
        title: tokenColor(`alert-${kind}`),
        text: kind.charAt(0).toUpperCase() + kind.slice(1),
        iconHidden: "true",
      })),
    );
  });

  test("a link on a slide keeps the light link colour in the dark theme", async () => {
    // The dark theme's link colour (primary-ink-dark) reads at 2.4:1 on the
    // white slide; footnote references put a link on many slides.
    document.documentElement.dataset["theme"] = "dark";
    await mountDeck(
      "## Links\n\nA claim.[^n] See [the spec](https://example.com/spec).\n\n[^n]: N.",
    );
    const colors = [...present().querySelectorAll("a")].map((a) => getComputedStyle(a).color);
    expect(colors.length).toBeGreaterThan(2);
    expect(new Set(colors)).toEqual(new Set([tokenColor("primary-ink")]));
  });

  test("document mode switches alerts to the dark set with the theme", async () => {
    document.documentElement.dataset["theme"] = "dark";
    const doc = await mountDocument(ALERT_DOC);
    const edges = ALERTS.map(
      (kind) =>
        getComputedStyle(doc.querySelector<HTMLElement>(`.markdown-alert-${kind}`)!)
          .borderInlineStartColor,
    );
    expect(edges).toEqual(ALERTS.map((kind) => tokenColor(`alert-${kind}-dark`)));
  });
});

describe("raw HTML on a slide", () => {
  test("a <kbd> in the text sits inline instead of taking the menu shortcut style", async () => {
    // The app's global kbd rule pushes a shortcut hint to the right edge of a menu row.
    await mountDeck("## Keys\n\nPress <kbd>Ctrl</kbd> + <kbd>K</kbd> to search.\n");
    const kbd = present().querySelector<HTMLElement>("kbd")!;
    expect(getComputedStyle(kbd).display).toBe("inline-block");
    expect(getComputedStyle(kbd).marginLeft).toBe("0px");
    expect(getComputedStyle(kbd).color).toBe(tokenColor("slide-ink"));
  });

  test("<details> opens on click and shows its Markdown body", async () => {
    await mountDeck(
      "## More\n\n<details>\n<summary>Show the plan</summary>\n\nThe *hidden* plan.\n\n</details>\n",
    );
    const details = present().querySelector("details")!;
    expect(details.open).toBe(false);
    // A DOM click: reveal's live region repeats the slide's text, so a text locator is ambiguous.
    details.querySelector("summary")!.click();
    expect(details.open).toBe(true);
    expect(details.querySelector("em")?.textContent).toBe("hidden");
  });
});

describe("document mode links", () => {
  test("a footnote reference scrolls to and focuses its definition, as on GitHub", async () => {
    const doc = await mountDocument(
      `${"Filler.\n\n".repeat(60)}A claim.[^src]\n\n[^src]: The source.`,
    );
    await userEvent.click(doc.querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!);
    expect(document.activeElement?.id).toBe("user-content-fn-src");
    const rect = document.activeElement!.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(-1); // sub-pixel rounding
    expect(rect.bottom).toBeLessThanOrEqual(800);
  });

  test("a link to a heading focuses that heading", async () => {
    const doc = await mountDocument(
      `[Jump](#retry-budget)\n\n${"Filler.\n\n".repeat(60)}#### Retry budget\n\nText.`,
    );
    await userEvent.click(doc.querySelector<HTMLAnchorElement>('a[href="#retry-budget"]')!);
    expect(document.activeElement?.id).toBe("user-content-retry-budget");
  });

  test("a link to a heading inside a list item focuses that heading (decision 107)", async () => {
    const doc = await mountDocument(
      `[Jump](#listed-step)\n\n${"Filler.\n\n".repeat(60)}- #### Listed step\n\n  Text.`,
    );
    await userEvent.click(doc.querySelector<HTMLAnchorElement>('a[href="#listed-step"]')!);
    expect(document.activeElement?.id).toBe("user-content-listed-step");
    expect(document.activeElement?.closest("li")).not.toBeNull();
  });
});
