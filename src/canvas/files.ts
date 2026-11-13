/**
 * Images a sketch may carry. Excalidraw keeps each image as a `dataURL` and
 * hands it to `new Image().src` without looking at the scheme, so a scene
 * whose file is `https://tracker.example/p.png` makes the browser fetch it
 * the moment the scene opens, and again each time the saved sketch reopens.
 * That would get around decision 33's click-to-load image gate and break
 * rule 8 (no outbound call the user did not ask for). Only inline images
 * pass: a `data:image/` URL is decoded from the scene itself.
 */

const INLINE_IMAGE = /^data:image\//i;

/** True for a file whose bytes travel inside the scene. */
function isInlineFile(file: unknown): boolean {
  if (typeof file !== "object" || file === null) return false;
  const dataURL = (file as { dataURL?: unknown }).dataURL;
  return typeof dataURL === "string" && INLINE_IMAGE.test(dataURL);
}

/** `files` without any file that would be fetched from somewhere. */
export function inlineFiles<T>(
  files: Readonly<Record<string, T>> | null | undefined,
): Record<string, T> {
  return Object.fromEntries(Object.entries(files ?? {}).filter(([, file]) => isInlineFile(file)));
}
