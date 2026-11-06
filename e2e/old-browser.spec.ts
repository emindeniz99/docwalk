import { expect, test, type Page } from "@playwright/test";

/**
 * Decision 78: a browser below the floor (decision 31) gets a notice instead
 * of a blank page. A real old browser is not available here, so each test
 * takes away one built-in the floor brings before the page's scripts run.
 */

const NOTICE = "docwalk needs a newer browser";

/** Records Content-Security-Policy violations: a blocked check is a blank page again. */
async function recordViolations(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(e.violatedDirective));
  });
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);

async function belowTheFloor(page: Page) {
  await recordViolations(page);
  await page.addInitScript(() => {
    // Safari 17.4, the floor, is where Promise.withResolvers arrived.
    delete (Promise as { withResolvers?: unknown }).withResolvers;
  });
}

test("a browser below the floor sees a notice, not a blank page or a broken app", async ({
  page,
}) => {
  await belowTheFloor(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: NOTICE })).toBeVisible();
  await expect(page.getByText(/Safari 17\.4 or later/)).toBeVisible();
  // The app would replace the notice with a page that fails part way.
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".docwalk-app")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: NOTICE })).toBeVisible();
  // It ran under the production CSP: the policy allows it by its hash.
  expect(await violations(page)).toEqual([]);
});

test("the notice follows the viewer's language like the app does", async ({ page }) => {
  await belowTheFloor(page);
  await page.addInitScript(() => localStorage.setItem("docwalk.locale", "tr"));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "docwalk daha yeni bir tarayıcı gerektiriyor" }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("tr");
});

test("a shared ?src= link still reaches its plain Markdown, and only over https", async ({
  page,
}) => {
  await belowTheFloor(page);
  const file = "https://raw.githubusercontent.com/example/docs/main/design.md";
  await page.goto(`/?src=${encodeURIComponent(file)}`);
  await expect(page.getByRole("link", { name: "Open the Markdown file" })).toHaveAttribute(
    "href",
    file,
  );
  // The query string is anyone's to write: a script URL never becomes a link.
  await page.goto(`/?src=${encodeURIComponent("javascript:alert(1)")}`);
  await expect(page.getByRole("heading", { level: 1, name: NOTICE })).toBeVisible();
  await expect(page.getByRole("link")).toHaveCount(0);
});

test("a current browser gets the app, with no notice and no CSP violation", async ({ page }) => {
  await recordViolations(page);
  await page.goto("/");
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, { timeout: 30_000 });
  await expect(page.getByText(NOTICE)).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});
