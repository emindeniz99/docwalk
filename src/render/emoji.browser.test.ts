import { afterEach, describe, expect, test } from "vitest";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown } from "../sectioning/sectionize";
import { renderEmoji, type EmojiNames } from "./emoji";
import { nodesToHtml } from "./toHtml";

/**
 * Decision 101. Emoji shortcodes are text, replaced in text nodes after both
 * sanitizers: nothing a shortcode names can become markup, code keeps what it
 * says, and the list is only fetched for text that could hold a shortcode.
 */

afterEach(() => {
  document.body.replaceChildren();
});

function html(markdown: string): HTMLElement {
  const box = document.createElement("div");
  box.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  document.body.append(box);
  return box;
}

describe("shortcodes in text", () => {
  test("a known name becomes its character, in any block that holds text", async () => {
    const box = html(
      [
        "# Launch :rocket:",
        "",
        "Ship it :+1: and :tada:",
        "",
        "- item :fire:",
        "",
        "| a |",
        "| - |",
        "| :white_check_mark: |",
        "",
        "[go :eyes:](https://example.com/:eyes:)",
      ].join("\n"),
    );
    await renderEmoji(box);
    expect(box.querySelector("h1")!.textContent).toBe("Launch 🚀");
    expect(box.querySelector("p")!.textContent).toBe("Ship it 👍 and 🎉");
    expect(box.querySelector("li")!.textContent).toBe("item 🔥");
    expect(box.querySelector("td")!.textContent).toBe("✅");
    const link = box.querySelector("a")!;
    expect(link.textContent).toBe("go 👀");
    // Only text changes: the address keeps what the author wrote.
    expect(link.getAttribute("href")).toBe("https://example.com/:eyes:");
  });

  test("two in a row, and one at each end", async () => {
    const box = html(":smile::smile: and :tada:");
    await renderEmoji(box);
    expect(box.textContent).toBe("😄😄 and 🎉");
  });

  test("an unknown name, a time and a lone colon stay as written", async () => {
    const box = html("Not :notanemoji: at 10:30:45, a: b, :Rocket: and ::");
    await renderEmoji(box);
    expect(box.textContent).toBe("Not :notanemoji: at 10:30:45, a: b, :Rocket: and ::");
  });

  test("names that are properties of Object are not emoji", async () => {
    // Escaped underscores: Markdown would read `__proto__` as bold `proto`.
    const box = html(":constructor: :\\_\\_proto\\_\\_: :toString: :hasOwnProperty: :valueOf:");
    const written = ":constructor: :__proto__: :toString: :hasOwnProperty: :valueOf:";
    expect(box.textContent).toBe(written);
    await renderEmoji(box);
    expect(box.textContent).toBe(written);
  });

  test("code, preformatted text, keys and math keep their shortcodes", async () => {
    const box = html("`:rocket:` and <kbd>:rocket:</kbd>\n\n```\n:rocket:\n```\n");
    const math = document.createElement("math");
    math.textContent = ":rocket:";
    box.append(math);
    await renderEmoji(box);
    expect(box.querySelector("p code")!.textContent).toBe(":rocket:");
    expect(box.querySelector("kbd")!.textContent).toBe(":rocket:");
    expect(box.querySelector("pre")!.textContent).toBe(":rocket:\n");
    expect(math.textContent).toBe(":rocket:");
  });

  test("a diagram host keeps its text", async () => {
    const host = document.createElement("div");
    host.className = "docwalk-diagram";
    host.textContent = "A :rocket: B";
    document.body.append(host);
    await renderEmoji(document.body);
    expect(host.textContent).toBe("A :rocket: B");
  });

  test("the result is text: no element is added", async () => {
    const box = html("<b>:rocket:</b> :fire:");
    const before = box.querySelectorAll("*").length;
    await renderEmoji(box);
    expect(box.querySelectorAll("*")).toHaveLength(before);
    expect(box.querySelector("b")!.firstChild!.nodeType).toBe(Node.TEXT_NODE);
  });
});

describe("the list loads only when it can matter", () => {
  const names: EmojiNames = new Map([["rocket", "🚀"]]);

  test("text with no shortcode shape never loads it", async () => {
    let loads = 0;
    const box = html("Plain text, 10:30 and a: b.");
    await renderEmoji(box, {
      load: async () => {
        loads++;
        return names;
      },
    });
    expect(loads).toBe(0);
  });

  test("times and timestamps never load it", async () => {
    // `14:03:00` holds `:03:`, and the sample document has such a timestamp
    // in a table: the list (30 kB gzip) would join every first visit.
    let loads = 0;
    const box = html("| Opened | Closed |\n| - | - |\n| 2026-11-05T14:03:00Z | 10:30:45 |\n");
    await renderEmoji(box, {
      load: async () => {
        loads++;
        return names;
      },
    });
    expect(loads).toBe(0);
  });

  test("a long run of name characters after a colon is scanned in linear time", async () => {
    // Rule 5: a document is hostile. A pattern that demands a letter
    // somewhere in the name backtracks quadratically on this.
    const box = document.createElement("p");
    box.textContent = `:${"a1".repeat(100_000)} and 12:${"0".repeat(100_000)}`;
    const started = performance.now();
    await renderEmoji(box, { load: async () => names });
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the four names without a letter still count", async () => {
    const box = html(":100: :1234: :+1: :-1:");
    await renderEmoji(box);
    expect(box.textContent).toBe("💯 🔢 👍 👎");
  });

  test("a shortcode shape loads it once for the whole root", async () => {
    let loads = 0;
    const box = html(":rocket: one\n\n:rocket: two");
    await renderEmoji(box, {
      load: async () => {
        loads++;
        return names;
      },
    });
    expect(loads).toBe(1);
    expect(box.textContent).toBe("🚀 one\n🚀 two");
  });

  test("a list that does not load leaves the text and resolves", async () => {
    const box = html("Go :rocket:");
    await renderEmoji(box, { load: () => Promise.reject(new Error("offline")) });
    expect(box.textContent).toBe("Go :rocket:");
  });

  test("a list that takes too long is given up on", async () => {
    const box = html("Go :rocket:");
    await renderEmoji(box, { timeoutMs: 20, load: () => new Promise(() => undefined) });
    expect(box.textContent).toBe("Go :rocket:");
  });

  test("a stale build changes nothing", async () => {
    const box = html("Go :rocket:");
    await renderEmoji(box, { stop: () => true, load: async () => names });
    expect(box.textContent).toBe("Go :rocket:");
  });
});
