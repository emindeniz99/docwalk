import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The message catalogues (decisions 30, 56). Paraglide compiles a key that
 * is missing in one locale into a silent fallback, and a variable the
 * translation drops or misspells into text that never shows the value, so
 * both are checked here, before anyone reads the Turkish UI.
 */
const root = join(import.meta.dirname, "../../messages");
const read = (locale: string) =>
  JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")) as Record<string, string>;
const en = read("en");
const tr = read("tr");

/** An ICU argument: its name and its type (`plural`, `select`, or "" for a plain value). */
interface Argument {
  name: string;
  type: string;
}

/**
 * The arguments an ICU MessageFormat 1 string uses, including those inside
 * plural and select branches. A small parser rather than a regex: in
 * `{count, plural, one {comment} other {comments}}` the branch text
 * `{comment}` is text, not an argument.
 */
function icuArguments(message: string): Argument[] {
  const found: Argument[] = [];
  let i = 0;
  const fail = (why: string) => {
    throw new Error(`${why} at ${i} in ${JSON.stringify(message)}`);
  };
  const skipSpace = () => {
    while (/\s/.test(message[i] ?? "")) i++;
  };
  const word = () => {
    const start = i;
    while (/[\w=-]/.test(message[i] ?? "")) i++;
    return message.slice(start, i);
  };
  /** Text up to the `}` that closes the current branch (or the end). */
  const pattern = (inBranch: boolean): void => {
    while (i < message.length) {
      const c = message[i];
      if (c === "'" && /[{}#']/.test(message[i + 1] ?? "")) {
        // A quoted literal: skip to the closing apostrophe.
        const end = message.indexOf("'", i + 1);
        i = end < 0 ? message.length : end + 1;
      } else if (c === "{") {
        i++;
        argument();
      } else if (c === "}") {
        if (!inBranch) fail("unmatched }");
        return;
      } else i++;
    }
    if (inBranch) fail("unclosed branch");
  };
  const argument = (): void => {
    skipSpace();
    const name = word();
    if (!/^[A-Za-z_]\w*$/.test(name)) fail(`bad argument name "${name}"`);
    skipSpace();
    let type = "";
    if (message[i] === ",") {
      i++;
      skipSpace();
      type = word();
      skipSpace();
    }
    found.push({ name, type });
    if (type === "plural" || type === "select" || type === "selectordinal") {
      if (message[i] !== ",") fail("missing options");
      i++;
      skipSpace();
      while (message[i] !== "}") {
        if (i >= message.length) fail("unclosed argument");
        const key = word();
        if (key.startsWith("offset")) {
          skipSpace();
          continue;
        }
        if (key === "") fail("missing branch key");
        skipSpace();
        if (message[i] !== "{") fail(`branch "${key}" has no text`);
        i++;
        pattern(true);
        i++;
        skipSpace();
      }
    } else if (type !== "") {
      // number, date and the like: skip a style up to the closing brace.
      while (i < message.length && message[i] !== "}") i++;
    }
    if (message[i] !== "}") fail("unclosed argument");
    i++;
  };
  pattern(false);
  return found;
}

const signature = (message: string) =>
  [...new Set(icuArguments(message).map((a) => `${a.name}:${a.type}`))].toSorted();

describe("every message exists in both locales with the same variables", () => {
  test("English and Turkish have the same keys", () => {
    expect(Object.keys(tr).toSorted()).toEqual(Object.keys(en).toSorted());
  });

  test("keys are valid Paraglide function names", () => {
    // Paraglide turns each key into an exported function of the same name.
    for (const key of Object.keys(en)) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test.each(Object.keys(en))("%s", (key) => {
    const source = en[key] ?? "";
    const translation = tr[key] ?? "";
    expect(translation.trim(), "empty translation").not.toBe("");
    // The same variables with the same kind: a translation that drops `{name}`
    // hides the value, and one that turns a plural into plain text loses the count.
    expect(signature(translation)).toEqual(signature(source));
    // Turkish plural rules have "one" and "other"; without "other" most counts render nothing.
    const pluralWithoutOther =
      /,\s*plural\s*,/.test(translation) && !/\bother\s*\{/.test(translation);
    expect(pluralWithoutOther, "plural without an other branch").toBe(false);
  });
});

describe("the ICU argument parser the parity test relies on", () => {
  test("finds plain, plural and nested arguments, and ignores branch text", () => {
    expect(
      icuArguments("{count, plural, one {Imported # file into {target}.} other {# files}}"),
    ).toEqual([
      { name: "count", type: "plural" },
      { name: "target", type: "" },
    ]);
    expect(icuArguments("{count, plural, one {comment} other {comments}}")).toEqual([
      { name: "count", type: "plural" },
    ]);
    expect(icuArguments("Hello {name}, it's {next, select, light {light} other {dark}}")).toEqual([
      { name: "name", type: "" },
      { name: "next", type: "select" },
    ]);
  });

  test("rejects a broken message instead of passing it", () => {
    expect(() => icuArguments("{count, plural, one {x}")).toThrow("unclosed argument");
    expect(() => icuArguments("text }")).toThrow("unmatched }");
  });
});
