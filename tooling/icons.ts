import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { ICON_FILES, iconSvg } from "./pwa.ts";

/**
 * `pnpm icons`: writes the app icons under public/ from `iconSvg()`, the
 * SVGs as text and the PNGs rendered by Chromium (no image library needed).
 * Run it after a colour token changes; `tooling/pwa.test.ts` fails until the
 * committed SVGs match the tokens again. DOCWALK_CHROMIUM_PATH picks a
 * preinstalled browser, as for the browser tests.
 */
const publicDir = join(import.meta.dirname, "..", "public");
const executablePath = process.env["DOCWALK_CHROMIUM_PATH"];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage();
  for (const icon of ICON_FILES) {
    const svg = iconSvg({ maskable: icon.maskable });
    const target = join(publicDir, icon.file);
    mkdirSync(dirname(target), { recursive: true });
    if (icon.size === null) {
      writeFileSync(target, svg);
    } else {
      await page.setViewportSize({ width: icon.size, height: icon.size });
      const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}</style><img src="${src}" width="${icon.size}" height="${icon.size}">`,
      );
      await page.waitForFunction("document.images[0].complete");
      writeFileSync(target, await page.screenshot({ omitBackground: true }));
    }
    console.log(`wrote public/${icon.file}`);
  }
} finally {
  await browser.close();
}
