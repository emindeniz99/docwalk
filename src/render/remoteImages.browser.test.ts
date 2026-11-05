import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { buildSlide } from "../deck/slides";
import { offline, prepareSlide } from "../export/pages";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { DocumentView } from "../shell/DocumentView";
import { MoreMenu } from "../shell/MoreMenu";
import {
  LOAD_REMOTE_IMAGES_KEY,
  enableClickToLoad,
  loadBlockedImage,
  setLoadRemoteImages,
} from "./remoteImages";
import { BLOCKED_IMAGE_CLASS } from "./toHtml";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `.invalid` never resolves, so loading one of these contacts nobody.
const REMOTE = "https://images.invalid/chart.png";

let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  setLoadRemoteImages(false);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

/** A slide body built by the real pipeline: rehype-sanitize, the gate, then DOMPurify. */
function slideBody(markdown: string): HTMLElement {
  const section = buildSlide(sectionize(parseMarkdown(markdown)).sections[0] as never);
  document.body.append(section);
  return section.querySelector(".docwalk-slide-body") as HTMLElement;
}

describe("the gate survives the whole pipeline", () => {
  test("a protocol-relative image has no src after DOMPurify, so the browser fetches nothing", () => {
    // DOMPurify's URI rule allows a leading `/`, so only the gate stops `//host`.
    const img = slideBody("## Img\n\n![pixel](//tracker.invalid/p.png?id=viewer)\n").querySelector(
      "img",
    ) as HTMLImageElement;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.classList.contains(BLOCKED_IMAGE_CLASS)).toBe(true);
    // The button semantics are not stripped by DOMPurify.
    expect(img.getAttribute("role")).toBe("button");
    expect(img.tabIndex).toBe(0);
  });
});

function blocked(markdown = `## Img\n\n![Chart](${REMOTE})\n`) {
  const body = slideBody(markdown);
  const stop = enableClickToLoad(body);
  return { body, stop, img: body.querySelector("img") as HTMLImageElement };
}

describe("click-to-load", () => {
  test("clicking a blocked image loads it and turns it back into a plain image", async () => {
    const { img } = blocked();
    await userEvent.click(img);
    expect(img.getAttribute("src")).toBe(REMOTE);
    expect(img.classList.contains(BLOCKED_IMAGE_CLASS)).toBe(false);
    expect(img.getAttribute("role")).toBeNull();
    expect(img.hasAttribute("tabindex")).toBe(false);
  });

  test("Enter on a focused blocked image loads it, so keyboard users are not locked out", async () => {
    const { img } = blocked();
    img.focus();
    await userEvent.keyboard("{Enter}");
    expect(img.getAttribute("src")).toBe(REMOTE);
  });

  test("a click that loads an image inside a link does not follow the link", () => {
    const { img } = blocked(`## Img\n\n[![Chart](${REMOTE})](https://elsewhere.invalid/)\n`);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    img.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(img.getAttribute("src")).toBe(REMOTE);
  });

  test("only https is ever loaded, whatever data-src holds", () => {
    // CSP allows https images only; anything else must stay a placeholder.
    for (const src of ["http://images.invalid/a.png", "javascript:alert(1)", "data:,x"]) {
      const img = document.createElement("img");
      img.className = BLOCKED_IMAGE_CLASS;
      img.dataset["src"] = src;
      expect(loadBlockedImage(img)).toBe(false);
      expect(img.getAttribute("src")).toBeNull();
    }
  });

  test("an exported slide keeps the placeholder but not the button, since nothing can load it there", () => {
    const { body } = blocked(`## Img\n\n![Chart](${REMOTE} "A title")\n`);
    const img = prepareSlide(body, offline).querySelector("img") as HTMLImageElement;
    expect(img.classList.contains(BLOCKED_IMAGE_CLASS)).toBe(true);
    for (const attr of ["src", "data-src", "role", "tabindex", "aria-label", "title"]) {
      expect(img.hasAttribute(attr)).toBe(false);
    }
    expect(img.alt).toBe("Chart");
  });

  test("after cleanup a click no longer loads anything", async () => {
    const { img, stop } = blocked();
    stop();
    await userEvent.click(img);
    expect(img.getAttribute("src")).toBeNull();
  });
});

describe("always load remote images", () => {
  test("document mode loads remote images once the setting is on, and blocks them again when off", () => {
    const view = render(h(DocumentView, { root: parseMarkdown(`![Chart](${REMOTE})\n`) }));
    const src = () => view.querySelector("img")?.getAttribute("src") ?? null;
    expect(src()).toBeNull();
    act(() => setLoadRemoteImages(true));
    expect(src()).toBe(REMOTE);
    act(() => setLoadRemoteImages(false));
    expect(src()).toBeNull();
  });

  test("document mode wires click-to-load", async () => {
    const view = render(h(DocumentView, { root: parseMarkdown(`![Chart](${REMOTE})\n`) }));
    await userEvent.click(view.querySelector("img") as HTMLImageElement);
    expect(view.querySelector("img")?.getAttribute("src")).toBe(REMOTE);
  });

  test("the More menu toggle is a checkbox item and the choice survives a reload", async () => {
    render(h(MoreMenu, { actions: [] }));
    await userEvent.click(document.querySelector('button[aria-label="More actions"]')!);
    const item = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((el) =>
      el.textContent?.includes("Always load remote images"),
    ) as HTMLElement;
    expect(item).toBeDefined();
    expect(item.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(item);
    // A viewer preference, not a token: localStorage is the right place (decision 35 covers tokens only).
    expect(localStorage.getItem(LOAD_REMOTE_IMAGES_KEY)).toBe("true");
  });

  test("the menu's other actions still run next to the toggle", async () => {
    let ran = 0;
    const Icon = (() => null) as never;
    render(h(MoreMenu, { actions: [{ id: "a", label: "Do it", Icon, run: () => ran++ }] }));
    await userEvent.click(document.querySelector('button[aria-label="More actions"]')!);
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === "Do it",
    ) as HTMLElement;
    await userEvent.click(item);
    expect(ran).toBe(1);
    expect(localStorage.getItem(LOAD_REMOTE_IMAGES_KEY)).toBeNull();
  });
});
