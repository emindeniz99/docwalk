import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The Turkish glossary in CONTEXT.md, checked against the catalogue. A
 * reader learns one word per concept from the UI; a second meaning for the
 * same word, or a word the glossary keeps for one place showing up in
 * another, makes a correct sentence say something else.
 */
const root = join(import.meta.dirname, "../../messages");
const read = (locale: string) =>
  JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")) as Record<string, string>;
const en = read("en");
const tr = read("tr");
const keysWhere = (match: (turkish: string, english: string) => boolean) =>
  Object.keys(tr).filter((key) => match(tr[key] ?? "", en[key] ?? ""));

describe("the Turkish catalogue follows CONTEXT.md", () => {
  test('"deste" names the deck only in the screen-reader role', () => {
    // Everywhere a sighted reader looks, the deck is "sunum"; "slayt destesi"
    // exists only because aria-roledescription needs a noun for the region.
    expect(keysWhere((turkish) => /deste/i.test(turkish))).toEqual(["deck_roledescription"]);
  });

  test('"izleyici" means a follower, never the audience window', () => {
    // The presenter window waits for its own main tab, not for a follower's
    // screen. "İzleyici penceresi bekleniyor" read as the second.
    // [iİ]: a case-insensitive /i/ does not match the dotted capital İ.
    expect(keysWhere((turkish) => /[iİ]zleyici\S*\s+pencere/i.test(turkish))).toEqual([]);
  });

  test('"upload" is never translated with "yükle", which means load here', () => {
    // "Belge yükleniyor…" and the Yükle button use yükle for loading, so
    // "hiçbir şey yüklenmedi" on the sample banner read as "nothing was
    // loaded" under a document that plainly had loaded, the opposite of
    // the privacy promise.
    expect(
      keysWhere((turkish, english) => /upload/i.test(english) && /yükle/i.test(turkish)),
    ).toEqual([]);
  });

  test('"slayt" softens to "slayd" before a vowel', () => {
    // The catalogue writes "slaydı" and "Slayda"; one "Slaytın" reads as a typo.
    expect(keysWhere((turkish) => /slayt[aeıioöuü]/i.test(turkish))).toEqual([]);
  });
});
