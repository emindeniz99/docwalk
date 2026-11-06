/**
 * Heading text in docwalk's chrome, marked as being in the document's
 * language, which docwalk does not know (`lang=""`), rather than inheriting
 * the UI's. The breadcrumb is uppercased by CSS, and under a Turkish UI an
 * English "Ledgerline" would otherwise become "LEDGERLİNE" (dotted İ).
 */
export function documentText(text: string): HTMLElement {
  const span = document.createElement("span");
  span.lang = "";
  span.textContent = text;
  return span;
}
