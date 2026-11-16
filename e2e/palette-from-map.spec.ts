import { expect, test, type Locator, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * Mod+K from wherever focus is (decision 81), with and without reduced
 * motion. Focus is moved with `focus()`, not a click or Tab, so React Aria
 * reads the interaction as "virtual", as when a screen reader moves focus:
 * the palette then focuses its search box only once every running CSS
 * transition has ended. Under reduced motion every element used to get an
 * `all 0.01ms` transition, the palette's own mount started some, and React
 * Aria lost track of one, so the box never got focus and Escape went nowhere.
 */

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

const cases: { view: "map" | "document"; start: (page: Page) => Locator }[] = [
  { view: "map", start: (page) => page.getByRole("region", { name: "Map", exact: true }) },
  { view: "document", start: (page) => page.locator(".docwalk-document a[href]").first() },
];

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test.describe(`with reducedMotion: ${reducedMotion}`, () => {
    test.use({ reducedMotion });

    for (const { view, start } of cases) {
      test(`Mod+K from the ${view} view focuses the search box, and Escape closes the palette and gives focus back`, async ({
        page,
      }) => {
        await ready(page, `/?view=${view}`);
        const from = start(page);
        await from.focus();
        await expect(from).toBeFocused();
        await page.keyboard.press("ControlOrMeta+k");
        await expect(palette(page)).toBeVisible();
        await expect(palette(page).getByRole("searchbox")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(palette(page)).toBeHidden();
        await expect(from).toBeFocused();
      });
    }
  });
}
