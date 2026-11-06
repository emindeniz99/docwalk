import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The app shell's JS and CSS, as paths relative to `dist`: what `index.html`
 * loads (entry script, modulepreloads, stylesheets) plus every file Vite
 * preloads for the lazy chunks main.tsx requests at once (`App`). This is a
 * floor, not the whole first load: App then fetches the editor, Mermaid and
 * each diagram type the deck uses. `e2e/perf.spec.ts` sums what the default
 * view really downloads and holds that to decision 43's limits; this list is
 * what `pnpm size` tracks and where the Monaco leak check looks.
 *
 * A lazy chunk's files are read from the preload list Vite writes next to its
 * `import()` in the entry chunk, which is the list the browser fetches. If
 * the build output stops matching that shape, this throws instead of
 * measuring less than users download.
 */
export function firstLoadFiles(dist: string, lazy: readonly string[] = ["App"]): string[] {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const files = new Set(
    [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1] as string),
  );
  const entry = /<script type="module"[^>]*src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error("first-load: no module entry script in index.html");
  const code = readFileSync(join(dist, entry), "utf8");

  const depsArray = /m\.f=(\[[^\]]*\])/.exec(code)?.[1];
  const deps: string[] = depsArray ? JSON.parse(depsArray) : [];
  for (const name of lazy) {
    const at = new RegExp(`import\\(\\s*[\`"']\\./${name}-[\\w-]+\\.js[\`"']\\s*\\)`).exec(code);
    if (!at) throw new Error(`first-load: no import() of the ${name} chunk in ${entry}`);
    const indices = /__vite__mapDeps\(\[([\d,]*)\]\)/.exec(code.slice(at.index))?.[1];
    if (indices === undefined) throw new Error(`first-load: no preload list for ${name}`);
    for (const i of indices.split(",").filter(Boolean)) {
      const file = deps[Number(i)];
      if (!file) throw new Error(`first-load: preload index ${i} of ${name} is out of range`);
      files.add(file);
    }
  }
  return [...files];
}

/**
 * The first-load files whose text contains `marker`. A bundler can merge a
 * lazy module into an eager chunk under another name, so the check reads the
 * contents instead of trusting file names.
 */
export function firstLoadFilesContaining(dist: string, marker: string): string[] {
  return firstLoadFiles(dist).filter((file) =>
    readFileSync(join(dist, file), "utf8").includes(marker),
  );
}
