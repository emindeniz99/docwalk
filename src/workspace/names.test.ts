import { describe, expect, test } from "vitest";
import {
  ancestorsOf,
  isDocumentName,
  isWithin,
  safeArchivePath,
  uniqueName,
  validateName,
  withMarkdownExtension,
} from "./names";
import { TEMPLATES, starter } from "./templates";

describe("validateName: names come from users and archives (rule 5)", () => {
  test("ordinary names pass, including spaces and dots inside", () => {
    const names = ["plan.md", "Q3 review", "v1.2 notes.md", "ünïcode.md"];
    expect(names.filter((name) => validateName(name) !== null)).toEqual([]);
  });

  test("anything that could address another place than the folder it is typed in is refused", () => {
    // A separator or a dot segment would let a rename move a file out of its folder.
    const names = ["a/b", "a\\b", "..", ".", "../x"];
    expect(names.filter((name) => validateName(name) === null)).toEqual([]);
  });

  test("names Windows refuses are refused everywhere, so a zip exported here opens there", () => {
    const names = ["a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "trailing.", "x\u0000y"];
    expect(names.filter((name) => validateName(name) === null)).toEqual([]);
  });

  test("empty, padded and overlong names get a readable reason", () => {
    expect(validateName("")).toBe("Enter a name.");
    expect(validateName(" plan.md")).toMatch(/space/);
    expect(validateName("a".repeat(256))).toMatch(/255/);
  });
});

describe("safeArchivePath: a zip entry never lands outside the target folder", () => {
  test("climbing entries are rejected, not clamped", () => {
    // Clamping `../../etc/x.md` to `etc/x.md` would hide the archive's intent; dropping it is honest.
    const raws = ["../escape.md", "a/../../b.md", "..\\win.md", "a/../b.md"];
    expect(raws.filter((raw) => safeArchivePath(raw) !== null)).toEqual([]);
  });

  test("absolute, Windows-style and dot-segment paths are read relative to the target", () => {
    expect(safeArchivePath("/abs/x.md")).toBe("abs/x.md");
    expect(safeArchivePath("dir\\sub\\x.md")).toBe("dir/sub/x.md");
    expect(safeArchivePath("./a//b.md")).toBe("a/b.md");
  });

  test("an entry with a name the workspace refuses is rejected", () => {
    expect(safeArchivePath("a/b:c.md")).toBeNull();
    expect(safeArchivePath("")).toBeNull();
    expect(safeArchivePath("/")).toBeNull();
  });
});

describe("helpers", () => {
  test("only Markdown and text files are documents", () => {
    expect(isDocumentName("a.md")).toBe(true);
    expect(isDocumentName("a.MARKDOWN")).toBe(true);
    expect(isDocumentName("a.txt")).toBe(true);
    expect(isDocumentName("a.png")).toBe(false);
    expect(isDocumentName("md")).toBe(false);
  });

  test("a file typed without an extension becomes Markdown, others keep theirs", () => {
    expect(withMarkdownExtension("plan")).toBe("plan.md");
    expect(withMarkdownExtension("notes.txt")).toBe("notes.txt");
  });

  test("uniqueName never returns a taken name, and numbers before the extension", () => {
    const taken = new Set(["handbook", "handbook 2", "a.md"]);
    expect(uniqueName("handbook", taken)).toBe("handbook 3");
    expect(uniqueName("a.md", taken)).toBe("a 2.md");
    expect(uniqueName("free", taken)).toBe("free");
  });

  test("ancestors and containment work on whole segments, not string prefixes", () => {
    expect(ancestorsOf("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.md")).toEqual([]);
    expect(isWithin("a/b.md", "a")).toBe(true);
    expect(isWithin("a", "a")).toBe(true);
    // `ab/x.md` is not inside `a`: a rename of `a` must not touch it.
    expect(isWithin("ab/x.md", "a")).toBe(false);
  });
});

describe("templates", () => {
  test("a project name cannot turn its title line into other Markdown", () => {
    // The name is typed by the user; `# ## x` or a newline would change the document's structure.
    expect(starter("## Sneaky\n# two")).toMatch(/^# Sneaky # two\n/);
    expect(starter("   ")).toMatch(/^# Untitled\n/);
  });

  test("every template opens a file it creates, and starts with the project name as title", () => {
    const broken = TEMPLATES.filter((t) => {
      const main = t.files("Atlas").find((f) => f.path === t.main);
      return !main?.text.startsWith("# Atlas\n");
    });
    expect(broken.map((t) => t.id)).toEqual([]);
  });
});
