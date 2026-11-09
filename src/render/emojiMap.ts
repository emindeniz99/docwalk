/**
 * The lazy half of emoji shortcodes (decision 101): gemoji's list, as a map
 * from a shortcode's name to its character. Imported only by `./emoji.ts`, and
 * only for text that holds a `:name:`. A `Map`, so a name such as
 * `constructor` or `__proto__` finds nothing.
 */
import { gemoji } from "gemoji";

export const emojiByName: ReadonlyMap<string, string> = new Map(
  gemoji.flatMap((entry) => entry.names.map((name): [string, string] => [name, entry.emoji])),
);
