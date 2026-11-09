import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { parseViewerUrl } from "../url/state";
import { BOARD_TEXT, boardAddress, boardKey, isBoardAddress, sectionOf } from "./board";

/**
 * A whiteboard belongs to a section, and its marks are mirrored and saved
 * under an address like a slide's (decision 110). Rule 7 says links name a
 * section, so the board address must never collide with `<section-id>/<n>`.
 */

// The same alphabet SectionIdSchema in src/url/state.ts accepts: letters,
// marks, digits, connector punctuation and "-", never "/".
const ID = /^[\p{Alphabetic}\p{M}\p{N}\p{Pc}-]{1,200}$/u;
const sectionId = fc
  .array(
    fc.constantFrom(
      ..."abcxyzABCXYZ0189-_".split(""),
      ..."çğıöşüéñßæø".split(""),
      ..."日本語한국어中文".split(""),
      ..."привет١٢٣ⓐ‿́".split(""),
    ),
    { minLength: 1, maxLength: 40 },
  )
  .map((chars) => chars.join(""))
  .filter((id) => ID.test(id));
const pageNumber = fc.integer({ min: 1, max: 999 });

describe("board addresses", () => {
  test("a board address is the section id and the word board", () => {
    expect(boardAddress("intro")).toBe("intro/board");
    expect(boardAddress("café-planı")).toBe("café-planı/board");
  });

  test("the key of a board carries BOARD_TEXT, so a board outlives edits to its section's text", () => {
    expect(BOARD_TEXT).toBe("0");
    expect(boardKey("intro")).toBe("intro/board#0");
  });

  test("isBoardAddress tells a board from a slide, so a receiver never draws a page's marks as a board's", () => {
    expect(isBoardAddress("intro/board")).toBe(true);
    expect(isBoardAddress("intro/1")).toBe(false);
    expect(isBoardAddress("intro")).toBe(false);
    expect(isBoardAddress("intro/board/1")).toBe(false);
    expect(isBoardAddress("/board")).toBe(false);
    expect(isBoardAddress("")).toBe(false);
  });

  test("sectionOf takes the part before the first slash, for a page address and a board address alike", () => {
    expect(sectionOf("intro/3")).toBe("intro");
    expect(sectionOf("intro/board")).toBe("intro");
    expect(sectionOf("intro")).toBe("intro");
  });

  fcTest.prop([sectionId, pageNumber])(
    "a board address never equals a slide address, so rule 7 holds and no link can open a board",
    (id, page) => {
      expect(boardAddress(id)).not.toBe(`${id}/${page}`);
      expect(isBoardAddress(`${id}/${page}`)).toBe(false);
      expect(isBoardAddress(boardAddress(id))).toBe(true);
    },
  );

  fcTest.prop([sectionId, pageNumber])(
    "sectionOf gives the id back from a board address and from every page address",
    (id, page) => {
      expect(sectionOf(boardAddress(id))).toBe(id);
      expect(sectionOf(`${id}/${page}`)).toBe(id);
    },
  );

  fcTest.prop([sectionId])(
    "the URL parser does not accept a board address as a slide address, so no link opens a board",
    (id) => {
      const url = new URL(`https://docwalk.example/#${encodeURIComponent(id)}/board`);
      expect(parseViewerUrl(url).address).toBeNull();
    },
  );
});
