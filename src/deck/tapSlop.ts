/**
 * CSS pixels a pointer may move between press and release and still tap
 * (decision 156). One value for the map and the focus view's diagram tour,
 * chosen so a finger's drift on a touch screen is a tap and a deliberate
 * pan is not. A leaf with no imports: the map's chunk and the deck both
 * take it without pulling in the other.
 */
export const TAP_SLOP = 10;
