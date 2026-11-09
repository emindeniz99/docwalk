/**
 * Transitional: the page still builds formulas itself until `renderMath`
 * reads them from the math worker. Deleted with that change.
 */
import "temml/dist/Temml-Local.css";
import { fromTree } from "./mathRebuild";
import { texToTree } from "./mathTree";

export { MAX_TEX_CHARS, MAX_TEX_NESTING, nestingOf } from "./mathTree";

export const buildMath = (tex: string, display: boolean): Element | null => {
  try {
    return fromTree(texToTree(tex, display), display);
  } catch {
    return null;
  }
};
