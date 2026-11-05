import { tokens } from "../src/design/tokens.ts";

/**
 * The installable-app pieces of decision 11 that are data, not code: the
 * brand mark, the web app manifest and the rule that picks what the service
 * worker precaches. Colours come from the token module, so a palette change
 * reaches the icons and the manifest too (decision 52).
 */

const c = tokens.colors;

/**
 * docwalk's mark: a white slide on the dark stage with a vermilion progress
 * bar under it, the Stage look of decision 49 reduced to a few shapes.
 * `maskable` fills the whole square and keeps the drawing inside the central
 * 80% circle that launchers may crop to; the plain icon has its own corners.
 */
export function iconSvg({ maskable = false }: { maskable?: boolean } = {}): string {
  // Drawn on a 512 grid. The slide and bar span 352 x 238 around the centre;
  // the maskable variant scales that by 0.8, so its farthest corner sits 170
  // from the centre, inside the 205 safe radius.
  const scale = maskable ? 0.8 : 1;
  const ground = maskable
    ? `<rect width="512" height="512" fill="${c.stage}"/>`
    : `<rect width="512" height="512" rx="112" fill="${c.stage}"/>`;
  const drawing = [
    `<rect x="80" y="137" width="352" height="198" rx="18" fill="${c.slide}"/>`,
    `<rect x="112" y="173" width="196" height="30" rx="6" fill="${c["slide-ink"]}"/>`,
    `<rect x="112" y="225" width="272" height="16" rx="8" fill="${c["border-strong"]}"/>`,
    `<rect x="112" y="257" width="216" height="16" rx="8" fill="${c["border-strong"]}"/>`,
    `<rect x="80" y="363" width="352" height="12" rx="6" fill="${c["stage-border"]}"/>`,
    `<rect x="80" y="363" width="212" height="12" rx="6" fill="${c.primary}"/>`,
  ].join("");
  const body =
    scale === 1
      ? drawing
      : `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${drawing}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${ground}${body}</svg>\n`;
}

export interface IconFile {
  /** Path under `public/`, which is also the path under the deploy root. */
  file: string;
  /** Square edge in pixels; `null` for the scalable SVG. */
  size: number | null;
  maskable: boolean;
}

/**
 * Every icon the app ships. The PNGs exist because the manifest's installable
 * criteria and iOS's home screen (`apple-touch-icon`, 180 px) want bitmaps;
 * `pnpm icons` renders them from `iconSvg()` in Chromium.
 */
export const ICON_FILES: readonly IconFile[] = [
  { file: "icons/icon.svg", size: null, maskable: false },
  { file: "icons/icon-maskable.svg", size: null, maskable: true },
  { file: "icons/icon-192.png", size: 192, maskable: false },
  { file: "icons/icon-512.png", size: 512, maskable: false },
  { file: "icons/icon-maskable-512.png", size: 512, maskable: true },
  { file: "icons/apple-touch-icon.png", size: 180, maskable: true },
];

/**
 * The web app manifest. Paths are relative to the manifest's own URL, so the
 * same build installs from a domain root or from a GitHub Pages subpath.
 */
export function webManifest() {
  const manifestIcons = ICON_FILES.filter((icon) => icon.file !== "icons/apple-touch-icon.png");
  return {
    id: "./",
    name: "docwalk",
    short_name: "docwalk",
    description: "Present a GitHub Markdown and Mermaid design doc as slides, online or offline.",
    lang: "en",
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: c.canvas,
    theme_color: c.canvas,
    icons: manifestIcons.map((icon) => ({
      src: icon.file,
      sizes: icon.size === null ? "any" : `${icon.size}x${icon.size}`,
      type: icon.size === null ? "image/svg+xml" : "image/png",
      purpose: icon.maskable ? "maskable" : "any",
    })),
  };
}

/** The `<meta name="theme-color">` pair for the browser chrome, following the system theme. */
export function themeColorMeta(): string {
  return [
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${c.canvas}" />`,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${c["canvas-dark"]}" />`,
  ].join("\n    ");
}

// ---- Precache selection ----------------------------------------------------

/** What the precache rule needs to know about one emitted JS chunk. */
export interface ChunkNode {
  fileName: string;
  isEntry: boolean;
  /** Chunks this one imports statically (they load with it). */
  imports: readonly string[];
  /** Chunks this one may `import()` later. */
  dynamicImports: readonly string[];
  /** Source modules bundled into the chunk. */
  moduleIds: readonly string[];
  /** CSS files Vite loads together with the chunk. */
  css: readonly string[];
}

/**
 * Packages whose lazy chunks are cached on first use even though docwalk's
 * own code imports them: opt-in modes far bigger than the rest of the app
 * (Monaco, decision 53; canvas mode, decision 54). Precaching them would make
 * every visitor download several megabytes for a mode most never open.
 */
export const RUNTIME_CACHED_PACKAGES: readonly RegExp[] = [
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?monaco-editor\//,
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@excalidraw\//,
];

const ownSource = (id: string) => !id.startsWith("\0") && !id.includes("/node_modules/");

/**
 * Splits the build's JS and CSS into what the service worker precaches and
 * what it caches on first use.
 *
 * Precached: every entry chunk and everything it imports, plus every chunk
 * docwalk's own source `import()`s (editor, parser, Mermaid's core, export,
 * share, presenter, remote) with its imports. That is the app a presenter
 * needs offline, whatever document they open.
 *
 * Cached on first use: the chunks a dependency loads by itself, which in
 * practice means Mermaid's per-diagram-type chunks and the layout engines
 * behind them (ELK alone is 1.4 MB, cytoscape 0.4 MB, KaTeX 0.26 MB). A deck
 * needs a handful of the dozens of types, so precaching all of them would
 * multiply every install for diagrams most documents never contain. Whatever
 * a deck rendered while online is then available offline.
 */
export function selectPrecache(
  chunks: readonly ChunkNode[],
  runtimeCached: readonly RegExp[] = RUNTIME_CACHED_PACKAGES,
): { precache: Set<string>; runtime: Set<string> } {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const precache = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = byName.get(name);
    if (!chunk) throw new Error(`precache: ${name} is imported but was not emitted`);
    if (chunk.moduleIds.some((id) => runtimeCached.some((pattern) => pattern.test(id)))) return;
    precache.add(chunk.fileName);
    for (const css of chunk.css) precache.add(css);
    for (const dep of chunk.imports) visit(dep);
    if (chunk.moduleIds.some(ownSource)) for (const dep of chunk.dynamicImports) visit(dep);
  };
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk.fileName);

  const runtime = new Set<string>();
  for (const chunk of chunks) {
    if (!precache.has(chunk.fileName)) runtime.add(chunk.fileName);
    for (const css of chunk.css) if (!precache.has(css)) runtime.add(css);
  }
  return { precache, runtime };
}

/** What the precache rule needs to know about one emitted non-chunk file. */
export interface AssetNode {
  fileName: string;
  /** Text of the file when it can name other files (CSS, HTML); `null` otherwise. */
  text: string | null;
}

/**
 * Build directories outside `assets/` that hold an opt-in mode's files and are
 * cached on first use: Excalidraw's self-hosted fonts (canvas mode, decision
 * 54), 13 MB of which are CJK slices fetched only for the glyphs a sketch uses.
 */
export const RUNTIME_CACHED_DIRS: readonly string[] = ["excalidraw-assets/"];

const baseName = (fileName: string) => fileName.slice(fileName.lastIndexOf("/") + 1);

/**
 * Splits the build's other files (fonts, workers, stylesheets, `index.html`)
 * the way `selectPrecache` splits chunks. A file under `assets/` is precached
 * only when precached code names it: the app's fonts are named by the
 * precached stylesheet, while Monaco's worker and codicon font, or the fonts
 * Excalidraw's stylesheet names, belong to modes that are cached on first use.
 * Other files are the shell (`index.html`), except `RUNTIME_CACHED_DIRS`.
 * Stylesheets are not decided here: `selectPrecache` places them with their
 * chunks, and any it did not precache stay runtime.
 *
 * `precachedCode` is the text of every precached chunk; the text of precached
 * stylesheets and of shell files is read from `assets`.
 */
export function selectAssets(
  assets: readonly AssetNode[],
  precached: ReadonlySet<string>,
  precachedCode: readonly string[],
  assetsDir = "assets",
  runtimeDirs: readonly string[] = RUNTIME_CACHED_DIRS,
): { precache: Set<string>; runtime: Set<string> } {
  const precache = new Set<string>();
  const runtime = new Set<string>();
  const inAssets = (name: string) => name.startsWith(`${assetsDir}/`);
  const optIn = (name: string) => runtimeDirs.some((dir) => name.startsWith(dir));
  const shell = assets.filter((a) => !inAssets(a.fileName) && !optIn(a.fileName));
  const referrers = [
    ...precachedCode,
    ...assets.filter((a) => precached.has(a.fileName)).map((a) => a.text ?? ""),
    ...shell.map((a) => a.text ?? ""),
  ];
  for (const asset of assets) {
    const name = asset.fileName;
    if (precached.has(name)) continue;
    // `selectPrecache` already placed every stylesheet with its chunk; a
    // lazy chunk's CSS is named in its importer's preload list, so naming
    // alone would wrongly pull an opt-in mode's styles into the precache.
    if (optIn(name) || name.endsWith(".css")) runtime.add(name);
    else if (!inAssets(name)) precache.add(name);
    else if (referrers.some((text) => text.includes(baseName(name)))) precache.add(name);
    else runtime.add(name);
  }
  return { precache, runtime };
}
