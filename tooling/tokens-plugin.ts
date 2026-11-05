import type { Plugin } from "vite";
import { tokensToCss } from "../src/design/css.ts";

const ID = "virtual:docwalk-tokens.css";
const RESOLVED = `\0${ID}`;

/** Serves `virtual:docwalk-tokens.css`, the design tokens as CSS variables, generated at build time. */
export function docwalkTokens(): Plugin {
  return {
    name: "docwalk-tokens",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      return id === RESOLVED ? tokensToCss() : undefined;
    },
  };
}
