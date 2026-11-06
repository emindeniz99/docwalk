import { Fragment, type ReactNode } from "react";

const OPEN = "";
const CLOSE = "";

/**
 * A message with React nodes (a `<strong>` name, a `<kbd>` key) in its
 * variables. Each variable goes in as a private-use marker, so the
 * translation decides where it sits; the text around it stays plain text and
 * is never parsed as markup.
 */
export function rich<K extends string>(
  format: (inputs: Record<K, string>) => string,
  nodes: Record<K, ReactNode>,
): ReactNode {
  const markers = Object.fromEntries(
    Object.keys(nodes).map((key) => [key, `${OPEN}${key}${CLOSE}`]),
  ) as Record<K, string>;
  const parts = format(markers).split(new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`));
  // split() with a capture group alternates text and variable names.
  return parts.map((part, i) =>
    i % 2 === 0 ? part : <Fragment key={i}>{nodes[part as K]}</Fragment>,
  );
}
