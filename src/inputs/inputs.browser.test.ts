import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { SourceBanner } from "./SourceBanner";
import { TokenDialog } from "./TokenDialog";
import { readToken, REFRESH_STORAGE_KEY } from "./token";
import { TOKEN_STORAGE_KEY } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

const TOKEN = "github_pat_" + "Q7".repeat(20);

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;

const open = (onTokenChange = vi.fn<(t: string | null) => void>()) => {
  render(h(TokenDialog, { isOpen: true, onOpenChange: () => {}, onTokenChange }));
  return onTokenChange;
};

/** The banner's text for one source, unmounted again so the next call starts clean. */
const bannerText = (source: Parameters<typeof SourceBanner>[0]["source"]) => {
  const el = render(h(SourceBanner, { source }));
  const value = el.textContent;
  act(() => root?.unmount());
  root = null;
  return value;
};

describe("TokenDialog", () => {
  test("the paste field is a named password input, so the token is not shown over a shared screen", () => {
    open();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    const input = dialog.querySelector("input")!;
    expect(input.type).toBe("password");
    expect(input.labels?.[0]?.textContent).toBe("Fine-grained token");
  });

  test("it says which scope to pick and links to GitHub's token settings and revoke list", () => {
    open();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Contents: Read-only");
    expect(dialog.textContent).toContain("Only select repositories");
    const links = [...dialog.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("https://github.com/settings/personal-access-tokens/new");
    expect(links).toContain("https://github.com/settings/personal-access-tokens");
    for (const a of dialog.querySelectorAll("a")) {
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });

  test("saving keeps the token in sessionStorage only, then Forget token removes it", async () => {
    const onTokenChange = open();
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await userEvent.click(input);
    await userEvent.keyboard(TOKEN);
    await userEvent.click(button("Save token"));

    expect(readToken()).toBe(TOKEN);
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(onTokenChange).toHaveBeenLastCalledWith(TOKEN);
    // The field empties: a saved token is never displayed again.
    expect(input.value).toBe("");
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/saved/i);

    expect(button("Forget token").disabled).toBe(false);
    await userEvent.click(button("Forget token"));
    expect(readToken()).toBeNull();
    expect(onTokenChange).toHaveBeenLastCalledWith(null);
  });

  test("Forget token by keyboard keeps focus in the dialog after the button disables itself", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    open();
    const forget = button("Forget token");
    forget.focus();
    await userEvent.keyboard("{Enter}");
    expect(readToken()).toBeNull();
    expect(forget.disabled).toBe(true);
    // Focus on <body> would strand a keyboard user outside the modal (WCAG 2.4.3).
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"] input'));
  });

  test("saving a pasted token drops leftover OAuth refresh state", async () => {
    sessionStorage.setItem(REFRESH_STORAGE_KEY, JSON.stringify({ refreshToken: "x" }));
    open();
    await userEvent.click(document.querySelector<HTMLInputElement>('[role="dialog"] input')!);
    await userEvent.keyboard(TOKEN);
    await userEvent.click(button("Save token"));
    expect(readToken()).toBe(TOKEN);
    expect(sessionStorage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
  });

  test("a bad paste is refused with a visible, announced error and nothing is stored", async () => {
    open();
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await userEvent.click(input);
    await userEvent.keyboard("not a token");
    await userEvent.click(button("Save token"));
    expect(readToken()).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector(".docwalk-inputs-error")?.textContent).toMatch(/GitHub token/);
  });

  test("Forget token is disabled while nothing is saved", () => {
    open();
    expect(button("Forget token").disabled).toBe(true);
  });

  test("every button is at least 44px high for touch", () => {
    open();
    for (const name of ["Save token", "Forget token", "Close"]) {
      expect(button(name).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("SourceBanner", () => {
  test("it names the host a document was loaded from", () => {
    const el = render(
      h(SourceBanner, {
        source: {
          kind: "url",
          url: "https://raw.githubusercontent.com/acme/docs/main/README.md",
          trusted: true,
        },
      }),
    );
    expect(el.textContent).toBe("Loaded from raw.githubusercontent.com");
  });

  test("repo, paste, file and fragment sources each say where the text came from", () => {
    expect(bannerText({ kind: "repo", repo: "acme/docs", path: "docs/a.md", ref: "main" })).toBe(
      "From GitHub acme/docs · docs/a.md @ main",
    );
    expect(bannerText({ kind: "paste" })).toBe("Pasted · saved in this browser");
    expect(bannerText({ kind: "file", name: "notes.md" })).toBe("Opened from file notes.md");
    expect(bannerText({ kind: "fragment" })).toBe("Opened from a shared link");
    expect(bannerText({ kind: "sample" })).toBe("");
  });

  test("an untrusted origin asks before loading, and Load / Cancel report the choice", async () => {
    const onLoad = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();
    const url = "https://docs.example.org/design.md";
    const el = render(
      h(SourceBanner, {
        source: null,
        confirm: { url, host: "docs.example.org" },
        onLoad,
        onCancel,
      }),
    );
    const region = el.querySelector("section")!;
    const title = document.getElementById(region.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("Load a document from docs.example.org?");
    expect(region.querySelector("code")?.textContent).toBe(url);
    await userEvent.click(button("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onLoad).not.toHaveBeenCalled();
    await userEvent.click(button("Load"));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  test("a lookalike host is shown in punycode, so it cannot pass for raw.githubusercontent.com", () => {
    const url = new URL("https://raw.githubuserсontent.com/a/b/main/x.md").href;
    const el = render(
      h(SourceBanner, {
        source: null,
        confirm: { url, host: "ignored" },
        onLoad() {},
        onCancel() {},
      }),
    );
    expect(el.querySelector("h2")?.textContent).toMatch(/xn--/);
  });

  test("markup in an address is shown as text, never parsed", () => {
    const url = "https://evil.example/<img src=x onerror=alert(1)>.md";
    const el = render(
      h(SourceBanner, {
        source: null,
        confirm: { url, host: "evil.example" },
        onLoad() {},
        onCancel() {},
      }),
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe(url);
  });

  test("the Load and Cancel buttons are 44px touch targets", () => {
    render(
      h(SourceBanner, {
        source: null,
        confirm: { url: "https://a.example/x.md", host: "a.example" },
        onLoad() {},
        onCancel() {},
      }),
    );
    for (const name of ["Load", "Cancel"]) {
      expect(button(name).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });
});
