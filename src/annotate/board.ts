/**
 * Whiteboard addresses (decision 110). A section has one whiteboard, a blank
 * page over its slide box with marks of its own. The marks travel through the
 * mirror and into saved marks under the board's address, `<section-id>/board`.
 *
 * Section ids contain no `/` and the page part of a slide address is digits,
 * so a board address never equals a slide address (rule 7), and no link opens
 * a board. The module has no DOM, so the mirror and the export can use it.
 */

/**
 * The text fingerprint of a board. A slide's key carries a hash of its text,
 * so an edit to the text drops the marks; `0` means "no text", so a board
 * outlives edits to its section.
 */
export const BOARD_TEXT = "0";

const SUFFIX = "/board";

/** The address of the whiteboard that belongs to a section. */
export function boardAddress(sectionId: string): string {
  return `${sectionId}${SUFFIX}`;
}

/** True for `<section-id>/board`, false for a slide address or anything else. */
export function isBoardAddress(address: string): boolean {
  return (
    address.length > SUFFIX.length &&
    address.endsWith(SUFFIX) &&
    !address.slice(0, -SUFFIX.length).includes("/")
  );
}

/** The section id of a page address or a board address: the part before the first `/`. */
export function sectionOf(pageAddress: string): string {
  const slash = pageAddress.indexOf("/");
  return slash === -1 ? pageAddress : pageAddress.slice(0, slash);
}

/**
 * The mark key of a section's board, in the shape `markKeys` gives a slide:
 * the address, `#`, then the text fingerprint. The saved-marks work replaces
 * this with its own `markKey` (decision 105).
 */
export function boardKey(sectionId: string): string {
  return `${boardAddress(sectionId)}#${BOARD_TEXT}`;
}
