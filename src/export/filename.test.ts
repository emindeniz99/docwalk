import { describe, expect, test } from "vitest";
import { htmlFileName, slideFileName, slugify } from "./filename";

describe("slide file names", () => {
  test("the index is zero-padded to the slide count, so files sort in deck order", () => {
    // Without padding a file browser lists 10-… before 2-….
    expect(slideFileName(2, 47, "intro/1")).toBe("02-intro-1.png");
    expect(slideFileName(47, 47, "summary/3")).toBe("47-summary-3.png");
    expect(slideFileName(7, 120, "a/1")).toBe("007-a-1.png");
  });

  test("the address slash becomes a dash, because a slash would make a folder", () => {
    expect(slideFileName(1, 9, "data-model/2")).toBe("1-data-model-2.png");
  });

  test("characters that are illegal or risky in file names never reach the name", () => {
    const name = slideFileName(1, 1, 'a:b*c?"d<e>f|g\\h/../i');
    expect(name).toBe("1-a-b-c-d-e-f-g-h-i.png");
    expect(name).not.toMatch(/[\\/:*?"<>|]|\.\./);
  });

  test("non-Latin section ids keep their letters, so a Turkish or Japanese deck gets readable names", () => {
    expect(slideFileName(3, 10, "veri-modeli-ğüş/1")).toBe("03-veri-modeli-ğüş-1.png");
    expect(slideFileName(1, 1, "設計/2")).toBe("1-設計-2.png");
  });

  test("an address with no letters or digits still yields a usable name", () => {
    expect(slideFileName(4, 12, "/")).toBe("04-slide.png");
  });

  test("very long section ids are capped so the name stays under file-system limits", () => {
    const slug = slugify("x".repeat(500));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slugify(`${"ab-".repeat(30)}`)).not.toMatch(/-$/);
  });
});

describe("HTML file name", () => {
  test("comes from the deck title, with a fallback for a title that slugs to nothing", () => {
    expect(htmlFileName("Ledger redesign: v2")).toBe("ledger-redesign-v2.html");
    expect(htmlFileName("???")).toBe("docwalk.html");
  });
});
