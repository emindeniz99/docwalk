/**
 * Points Excalidraw at the fonts this origin serves (tooling/excalidraw-assets-plugin.ts).
 * Without it Excalidraw fetches them from esm.sh, a third party (decision 51).
 * Imported for its side effect before `@excalidraw/excalidraw`, so the path
 * is set before Excalidraw registers a single font.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const EXCALIDRAW_ASSET_PATH = new URL(
  `${import.meta.env.BASE_URL}excalidraw-assets/`,
  location.origin,
).href;

window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
