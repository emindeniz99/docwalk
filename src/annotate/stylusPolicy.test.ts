import { describe, expect, test } from "vitest";
import { acceptedInput, slideOwner, type PointerKind } from "./stylusPolicy";

/**
 * Who owns a touch of the slide once a stylus is around (decision 110). A pen
 * draws with no tool chosen; after the first pen, a finger draws nothing and
 * moves no laser, so a swipe changes slide and a tap shows the controls.
 * Until a pen appears fingers draw as before, and a mouse always works as
 * before. These tests pin every row of the table, so a change to one rule
 * names the row it breaks.
 */

type Tool = "none" | "pen" | "laser";
const state = (tool: Tool, stylusDraws: boolean, penInUse: boolean) => ({
  drawingTool: tool === "pen",
  laser: tool === "laser",
  stylusDraws,
  penInUse,
});

const TOOLS: Tool[] = ["none", "pen", "laser"];
const ON = true;
const OFF = false;

describe("slideOwner: does a pointer on the slide belong to the tool?", () => {
  type Row = [PointerKind, Tool, boolean, boolean, boolean, string];
  // pointerType, tool, setting, pen in use, owner, reason
  const rows: Row[] = [
    // A mouse is never changed by the stylus setting or the latch.
    ["mouse", "none", ON, OFF, false, "a mouse with no tool leaves the slide to clicks and links"],
    ["mouse", "none", ON, ON, false, "a pen in use does not change what a mouse does with no tool"],
    ["mouse", "none", OFF, OFF, false, "a mouse with no tool, setting off"],
    ["mouse", "none", OFF, ON, false, "a mouse with no tool, setting off, pen in use"],
    ["mouse", "pen", ON, OFF, true, "a mouse draws with the pen tool"],
    ["mouse", "pen", ON, ON, true, "a mouse still draws with the pen tool once a pen is in use"],
    ["mouse", "pen", OFF, OFF, true, "a mouse draws with the pen tool, setting off"],
    ["mouse", "pen", OFF, ON, true, "a mouse draws with the pen tool, setting off, pen in use"],
    ["mouse", "laser", ON, OFF, true, "a mouse moves the laser"],
    ["mouse", "laser", ON, ON, true, "a mouse still moves the laser once a pen is in use"],
    ["mouse", "laser", OFF, OFF, true, "a mouse moves the laser, setting off"],
    ["mouse", "laser", OFF, ON, true, "a mouse moves the laser, setting off, pen in use"],
    // A pen owns the slide whenever the setting is on, tool or not.
    ["pen", "none", ON, OFF, true, "the first pen draws with no tool chosen"],
    ["pen", "none", ON, ON, true, "a pen draws with no tool chosen"],
    [
      "pen",
      "none",
      OFF,
      OFF,
      false,
      "with the setting off a pen is a mouse: no tool, no ownership",
    ],
    ["pen", "none", OFF, ON, false, "with the setting off a pen in use is still a mouse"],
    ["pen", "pen", ON, OFF, true, "a pen uses the chosen pen tool"],
    ["pen", "pen", ON, ON, true, "a pen in use uses the chosen pen tool"],
    [
      "pen",
      "pen",
      OFF,
      OFF,
      true,
      "with the setting off a pen acts as a mouse, which the pen tool owns",
    ],
    ["pen", "pen", OFF, ON, true, "the same with a pen in use"],
    ["pen", "laser", ON, OFF, true, "a pen moves the laser"],
    ["pen", "laser", ON, ON, true, "a pen in use moves the laser"],
    [
      "pen",
      "laser",
      OFF,
      OFF,
      true,
      "with the setting off a pen acts as a mouse and moves the laser",
    ],
    ["pen", "laser", OFF, ON, true, "the same with a pen in use"],
    // A finger loses the slide only when the setting is on and a pen has been seen.
    ["touch", "none", ON, OFF, false, "a finger with no tool leaves the slide to taps and swipes"],
    ["touch", "none", ON, ON, false, "a finger with no tool, pen in use: same"],
    ["touch", "none", OFF, OFF, false, "a finger with no tool, setting off: same"],
    ["touch", "none", OFF, ON, false, "a finger with no tool, setting off, pen in use: same"],
    ["touch", "pen", ON, OFF, true, "until a pen appears a finger draws as before"],
    [
      "touch",
      "pen",
      ON,
      ON,
      false,
      "once a pen is in use a finger draws nothing: it swipes and taps",
    ],
    ["touch", "pen", OFF, OFF, true, "with the setting off a finger draws as before"],
    [
      "touch",
      "pen",
      OFF,
      ON,
      true,
      "with the setting off a pen in use does not take the finger away",
    ],
    ["touch", "laser", ON, OFF, true, "until a pen appears a finger moves the laser"],
    ["touch", "laser", ON, ON, false, "once a pen is in use a finger moves no laser"],
    ["touch", "laser", OFF, OFF, true, "with the setting off a finger moves the laser as before"],
    [
      "touch",
      "laser",
      OFF,
      ON,
      true,
      "with the setting off a pen in use does not take the finger away from the laser",
    ],
  ];

  test("the table covers every pointer type, tool, setting and latch once", () => {
    const seen = new Set(rows.map(([p, t, s, l]) => `${p}/${t}/${s}/${l}`));
    expect(seen.size).toBe(3 * TOOLS.length * 2 * 2);
    expect(rows).toHaveLength(36);
  });

  test.each(rows)(
    "%s, tool %s, setting %s, pen in use %s gives %s: %s",
    (pointerType, tool, setting, latch, owner) => {
      expect(slideOwner({ pointerType, ...state(tool, setting, latch) })).toBe(owner);
    },
  );
});

describe("acceptedInput: what the active drauu accepts", () => {
  type Row = [Tool, boolean, boolean, readonly string[] | undefined, string];
  // tool, setting, pen in use, accepted, reason
  const rows: Row[] = [
    [
      "pen",
      ON,
      OFF,
      undefined,
      "until a pen appears the drawing accepts every pointer, fingers included",
    ],
    [
      "pen",
      ON,
      ON,
      ["pen", "mouse"],
      "once a pen is in use the drawing leaves the touch alone, so reveal.js swipes",
    ],
    ["pen", OFF, OFF, undefined, "setting off, no pen: every pointer"],
    ["pen", OFF, ON, undefined, "setting off: a pen in use changes nothing, a finger still draws"],
    ["none", ON, OFF, undefined, "no tool, no pen: nothing to restrict"],
    ["none", ON, ON, undefined, "no drawing tool: the surface takes no pointer anyway"],
    ["none", OFF, OFF, undefined, "no tool, setting off"],
    ["none", OFF, ON, undefined, "no tool, setting off, pen in use"],
    ["laser", ON, OFF, undefined, "the laser has its own handlers, not drauu's"],
    [
      "laser",
      ON,
      ON,
      undefined,
      "the laser skips touch in its own handlers, so drauu stays unrestricted",
    ],
    ["laser", OFF, OFF, undefined, "laser, setting off"],
    ["laser", OFF, ON, undefined, "laser, setting off, pen in use"],
  ];

  test.each(rows)(
    "tool %s, setting %s, pen in use %s gives %j: %s",
    (tool, setting, latch, accepted) => {
      expect(acceptedInput(state(tool, setting, latch))).toEqual(accepted);
    },
  );
});
