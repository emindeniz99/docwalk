import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build, type Plugin, type ResolvedConfig } from "vite";
import { ICON_FILES, selectPrecache, themeColorMeta, webManifest, type ChunkNode } from "./pwa.ts";

/** One precache entry in Workbox's shape; `revision: null` for content-hashed files. */
interface PrecacheEntry {
  url: string;
  revision: string | null;
}

const MANIFEST_FILE = "manifest.webmanifest";
/** Above this the build warns: the precache is what every visitor downloads once. */
const PRECACHE_WARN_BYTES = 6_000_000;

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

const revision = (content: string | Uint8Array) =>
  createHash("sha256").update(content).digest("hex").slice(0, 16);

/**
 * Makes the build an installable, offline-capable app (decision 11): emits
 * the web app manifest, links it and the theme colour from `index.html`,
 * picks the precache list from the bundle graph (`selectPrecache`) and
 * builds `src/pwa/sw.ts` into `sw.js` with that list inlined.
 *
 * Hand-rolled rather than vite-plugin-pwa because that plugin needs
 * workbox-build, whose dependency tree pnpm's `trustPolicy: no-downgrade`
 * rejects (a forked Rollup plugin published with weaker provenance than its
 * predecessor). The Workbox runtime modules the worker uses pass the policy.
 */
export function docwalkPwa(): Plugin {
  let config: ResolvedConfig;
  let entries: PrecacheEntry[] = [];
  return {
    name: "docwalk-pwa",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html.replace(
          "</head>",
          `  <link rel="manifest" href="${config.base}${MANIFEST_FILE}" />\n    ${themeColorMeta()}\n  </head>`,
        ),
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const manifest = `${JSON.stringify(webManifest(), null, 2)}\n`;
        this.emitFile({ type: "asset", fileName: MANIFEST_FILE, source: manifest });

        const chunks: ChunkNode[] = [];
        const sizes = new Map<string, number>();
        const others: PrecacheEntry[] = [];
        for (const file of Object.values(bundle)) {
          if (file.type === "chunk") {
            sizes.set(file.fileName, Buffer.byteLength(file.code));
            chunks.push({
              fileName: file.fileName,
              isEntry: file.isEntry,
              imports: file.imports,
              dynamicImports: file.dynamicImports,
              moduleIds: file.moduleIds,
              css: [...(file.viteMetadata?.importedCss ?? [])],
            });
            continue;
          }
          const size =
            typeof file.source === "string"
              ? Buffer.byteLength(file.source)
              : file.source.byteLength;
          sizes.set(file.fileName, size);
          if (file.fileName.endsWith(".css") || file.fileName.endsWith(".map")) continue;
          // index.html, the manifest, the self-hosted fonts: all part of the shell.
          const hashed = file.fileName.startsWith(`${config.build.assetsDir}/`);
          others.push({ url: file.fileName, revision: hashed ? null : revision(file.source) });
        }

        const { precache, runtime } = selectPrecache(chunks);
        const icons = ICON_FILES.map(({ file }) => {
          const content = readFileSync(join(config.publicDir, file));
          sizes.set(file, content.byteLength);
          return { url: file, revision: revision(content) };
        });
        sizes.set(MANIFEST_FILE, Buffer.byteLength(manifest));
        entries = [
          ...[...precache].toSorted().map((url) => ({ url, revision: null })),
          ...others,
          { url: MANIFEST_FILE, revision: revision(manifest) },
          ...icons,
        ];

        const total = entries.reduce((sum, entry) => sum + (sizes.get(entry.url) ?? 0), 0);
        const runtimeBytes = [...runtime].reduce((sum, file) => sum + (sizes.get(file) ?? 0), 0);
        config.logger.info(
          `docwalk-pwa: precaching ${entries.length} files (${mb(total)}); ` +
            `${runtime.size} files (${mb(runtimeBytes)}) are cached on first use`,
        );
        if (total > PRECACHE_WARN_BYTES)
          this.warn(
            `the precache is ${mb(total)}, over ${mb(PRECACHE_WARN_BYTES)}: ` +
              "a large opt-in mode may belong in RUNTIME_CACHED_PACKAGES (tooling/pwa.ts)",
          );
      },
    },
    async closeBundle() {
      // A separate build: a service worker must be one classic script at the
      // deploy root, while the app is ES modules under assets/.
      await build({
        configFile: false,
        root: config.root,
        logLevel: "warn",
        mode: "production",
        define: {
          DOCWALK_PRECACHE: JSON.stringify(entries),
          "process.env.NODE_ENV": JSON.stringify("production"),
        },
        build: {
          outDir: config.build.outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: config.build.target,
          minify: true,
          lib: {
            entry: join(config.root, "src/pwa/sw.ts"),
            formats: ["iife"],
            name: "docwalkServiceWorker",
            fileName: () => "sw.js",
          },
        },
      });
    },
  };
}
