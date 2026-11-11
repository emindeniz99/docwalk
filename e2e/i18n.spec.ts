import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * The Turkish UI (decisions 30, 56): a Turkish browser opens in Turkish, the
 * More menu and the palette switch languages, the choice survives a reload,
 * and a switch keeps the draft and the slide. Every string is checked in the
 * assembled app, because a component that does not re-render on a switch
 * passes its own tests and still shows English here.
 */

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** The deck has rendered in Turkish ("50 slayt" in the status bar). */
async function readyTr(page: Page) {
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slayt/, { timeout: 30_000 });
  // The count beside it names overflow notes, not speaker notes (decisions 130 and 135).
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ taşma notu/);
}

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
}

async function chooseFromMoreMenu(page: Page, language: "English" | "Türkçe") {
  await page.getByRole("button", { name: /^(More actions|Diğer işlemler)$/ }).click();
  await page.getByRole("menuitemradio", { name: language }).click();
}

test.describe("a browser that prefers Turkish", () => {
  test.use({ locale: "tr-TR" });

  test("opens in Turkish without being asked, and sets the page language", async ({ page }) => {
    // navigator.languages decides the first visit; nothing is stored until the viewer chooses.
    await page.goto("/");
    await readyTr(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "tr");
    await expect(page.getByRole("button", { name: "Sunum yap" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("docwalk.locale"))).toBeNull();
  });

  test("an explicit English choice wins over the browser's language", async ({ page }) => {
    await page.goto("/");
    await readyTr(page);
    await chooseFromMoreMenu(page, "English");
    await expect(page.getByRole("button", { name: "Present" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, {
      timeout: 30_000,
    });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});

test("switching to Turkish translates the header, menus and dialogs, and a reload stays Turkish", async ({
  page,
}) => {
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await chooseFromMoreMenu(page, "Türkçe");

  await expect(page.locator("html")).toHaveAttribute("lang", "tr");
  const header = page.locator(".docwalk-toolbar");
  await expect(header.getByRole("radio", { name: "Düzenle" })).toBeChecked();
  await expect(header.getByRole("radio", { name: "Belge" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Paylaş" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Dışa aktar" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Sunum yap" })).toBeVisible();
  await expect(page.locator(".docwalk-doc-title")).toContainText("Örnek belge");
  await expect(page.locator(".docwalk-statusbar")).toContainText("Sunucuya hiçbir şey gönderilmez");
  await expect(page.getByRole("navigation", { name: "Ana hat" })).toBeVisible();
  // The deck rebuilds its own DOM in Turkish too.
  await expect(page.locator(".reveal")).toHaveAttribute("aria-label", "Slaytlar");
  await expect(page.locator(".reveal")).toHaveAttribute("aria-roledescription", "slayt destesi");
  // reveal.js names its own arrows in English; docwalk renames them.
  await expect(page.locator(".reveal .controls .navigate-right")).toHaveAttribute(
    "aria-label",
    "Sonraki slayt",
  );

  // The More menu: its actions, and the language radio now on Türkçe.
  await page.getByRole("button", { name: "Diğer işlemler" }).click();
  await expect(page.getByRole("menuitem", { name: "Sunucu görünümünü aç" })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: "Türkçe" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");

  // The export menu and the command palette.
  await header.getByRole("button", { name: "Dışa aktar" }).click();
  await expect(page.getByRole("menuitem", { name: "Yazdır veya PDF olarak kaydet" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Komut paleti" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("menuitem", { name: "Slaytlara genel bakış" })).toBeVisible();
  await expect(palette.getByRole("menuitem", { name: "Dil: English" })).toBeVisible();
  await page.keyboard.press("Escape");

  // A dialog.
  await header.getByRole("button", { name: "Paylaş" }).click();
  await expect(page.getByRole("dialog", { name: "Bu belgeyi paylaş" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bağlantıyı kopyala" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The choice is remembered in this browser and applied before the first paint of text.
  expect(await page.evaluate(() => localStorage.getItem("docwalk.locale"))).toBe("tr");
  await page.reload();
  await readyTr(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "tr");
  await expect(header.getByRole("button", { name: "Sunum yap" })).toBeVisible();
});

test("the palette switches the language too", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("searchbox").fill("Türkçe");
  await page.getByRole("menuitem", { name: "Language: Türkçe" }).click();
  await readyTr(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("searchbox").fill("English");
  await page.getByRole("menuitem", { name: "Dil: English" }).click();
  await expect(page.getByRole("button", { name: "Present" })).toBeVisible();
});

test("a switch keeps the draft and the slide the viewer is on (decision 30)", async ({ page }) => {
  await ready(page);
  const draft =
    "# Round trip\n\n## First point\n\nAlpha.\n\n## Second point\n\nBeta, typed before the switch.\n";
  await replaceSource(page, draft);
  await page.getByRole("option", { name: /Second point/ }).click();
  const address = page.locator(".docwalk-preview-head span").first();
  await expect(address).toHaveText("second-point/1");
  await expect(page).toHaveURL(/#second-point\/1$/);

  await chooseFromMoreMenu(page, "Türkçe");
  await readyTr(page);
  // The deck rebuilt in Turkish and came back to the same slide, with the typed text.
  await expect(address).toHaveText("second-point/1");
  await expect(page.locator(".docwalk-preview-head strong")).toHaveText("3 / 3");
  await expect(page.locator(".cm-content")).toContainText("Beta, typed before the switch.");
  await expect(page.locator(".reveal section.present")).toContainText(
    "Beta, typed before the switch.",
  );
  // The document is not Turkish just because the UI is: its uppercased
  // breadcrumb keeps a plain I ("TRIP", not "TRİP"). innerText applies text-transform.
  await expect(page.locator(".reveal section.present .docwalk-breadcrumb")).toHaveJSProperty(
    "innerText",
    "ROUND TRIP",
  );

  await chooseFromMoreMenu(page, "English");
  await expect(page.locator(".docwalk-statusbar")).toContainText("3 slides");
  await expect(address).toHaveText("second-point/1");
  await expect(page.locator(".cm-content")).toContainText("Beta, typed before the switch.");
});

test.describe("accessibility in Turkish", () => {
  test.use({ locale: "tr-TR" });

  test("edit view, palette and share dialog pass axe", async ({ page }) => {
    // Longer Turkish labels must keep their names, contrast and targets.
    await page.goto("/");
    await readyTr(page);
    await expectNoSeriousViolations(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Komut paleti" })).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Paylaş" }).click();
    await expect(page.getByRole("dialog", { name: "Bu belgeyi paylaş" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Bağlantıyı kopyala" })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("the phone header still fits at 390 px in Turkish", async ({ page }) => {
    // Turkish words run longer; the header must not push the page sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await readyTr(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const present = await page.getByRole("button", { name: "Sunum yap" }).boundingBox();
    expect(present && present.x + present.width).toBeLessThanOrEqual(390);
    await expectNoSeriousViolations(page);
  });
});
