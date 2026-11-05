import { expect, test } from "@playwright/test";
import { CORS, docTitle, outline, ready, REMOTE_DOC } from "./helpers";

/**
 * Loading documents from links (decisions 5, 6 and 35) in the assembled app:
 * the start-up order, the host allowlist, the confirmation prompt and the
 * token retry only exist once the loaders, the banner and the dialog are
 * wired together, so unit tests of each part cannot see them.
 */

const RAW = "https://raw.githubusercontent.com/acme/docs/main/design.md";

test("?src= on raw.githubusercontent.com loads directly and says where it came from", async ({
  page,
}) => {
  // The allowlisted host must not ask: a confirmation on every GitHub link
  // would train users to click through the one that matters.
  await page.route(RAW, (route) =>
    route.fulfill({ contentType: "text/plain; charset=utf-8", headers: CORS, body: REMOTE_DOC }),
  );
  await ready(page, `/?src=${encodeURIComponent(RAW)}`);
  await expect(docTitle(page)).toHaveText("Remote design doc");
  await expect(page.locator(".docwalk-doc-title")).toContainText(
    "Loaded from raw.githubusercontent.com",
  );
  await expect(page.getByRole("region", { name: /Load a document/ })).toHaveCount(0);
  expect(await outline(page)).toEqual(
    expect.arrayContaining([expect.stringContaining("Loaded slide one")]),
  );
});

test("another host asks first: Cancel sends no request, Load fetches it", async ({ page }) => {
  // Fetching an arbitrary host the moment a link is opened would let any
  // link make the browser call any server (decision 6).
  const url = "https://docs.example.org/design.md";
  let requests = 0;
  await page.route(url, (route) => {
    requests += 1;
    return route.fulfill({ contentType: "text/markdown", headers: CORS, body: REMOTE_DOC });
  });

  await ready(page, `/?src=${encodeURIComponent(url)}`);
  const prompt = page.getByRole("region", { name: "Load a document from docs.example.org?" });
  await expect(prompt).toBeVisible();
  // The prompt appears without a click, so focus has to announce it.
  await expect(prompt.getByRole("button", { name: "Load" })).toBeFocused();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(docTitle(page)).toHaveText(/Ledgerline/);
  expect(requests).toBe(0);

  await ready(page, `/?src=${encodeURIComponent(url)}`);
  await page.getByRole("button", { name: "Load" }).click();
  await expect(docTitle(page)).toHaveText("Remote design doc");
  await expect(page.locator(".docwalk-doc-title")).toContainText("Loaded from docs.example.org");
  expect(requests).toBe(1);
});

test("a private ?repo= offers the token dialog, retries with the token, and keeps it out of localStorage", async ({
  page,
}) => {
  // Decision 35: a pasted token lives in sessionStorage only, so it dies
  // with the tab; and a refused load must lead somewhere, not dead-end.
  const token = "github_pat_EXAMPLE0000000000000000000000";
  const auth: (string | null)[] = [];
  await page.route("https://api.github.com/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const header = request.headers()["authorization"] ?? null;
    auth.push(header);
    if (header !== `Bearer ${token}`) {
      return route.fulfill({ status: 404, headers: CORS, json: { message: "Not Found" } });
    }
    expect(request.url()).toBe(
      "https://api.github.com/repos/acme/private-docs/contents/docs/design.md",
    );
    return route.fulfill({
      headers: CORS,
      contentType: "application/vnd.github.raw",
      body: REMOTE_DOC,
    });
  });

  await ready(page, "/?repo=acme/private-docs&path=docs/design.md");
  await expect(page.getByRole("status").getByText(/not found/)).toBeVisible();
  await page.getByRole("button", { name: "Add a GitHub token" }).click();
  const dialog = page.getByRole("dialog", { name: "GitHub access token" });
  await dialog.getByLabel("Fine-grained token").fill(token);
  await dialog.getByRole("button", { name: "Save token" }).click();

  await expect(docTitle(page)).toHaveText("Remote design doc");
  await expect(page.locator(".docwalk-doc-title")).toContainText("From GitHub acme/private-docs");
  expect(auth).toEqual([null, `Bearer ${token}`]);
  const stored = await page.evaluate(() => ({
    session: sessionStorage.getItem("docwalk.github-token"),
    local: Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? ""),
  }));
  expect(stored.session).toBe(token);
  expect(stored.local.some((value) => value.includes(token))).toBe(false);
});
