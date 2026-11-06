import { describe, expect, test } from "vitest";
import { isApplePlatform } from "./platform";

// Shortcut hints must name a key the viewer's keyboard has: ⌘ only on Apple
// devices, Ctrl on Windows, Linux, ChromeOS and Android.
describe("isApplePlatform", () => {
  test("trusts userAgentData's platform where the browser has it (Chromium)", () => {
    expect(isApplePlatform({ userAgent: "", userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isApplePlatform({ userAgent: "", userAgentData: { platform: "Windows" } })).toBe(false);
    expect(isApplePlatform({ userAgent: "", userAgentData: { platform: "Linux" } })).toBe(false);
    expect(isApplePlatform({ userAgent: "", userAgentData: { platform: "Chrome OS" } })).toBe(
      false,
    );
  });

  test("falls back to the user agent string in Safari and Firefox", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0";
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const windows =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
    const linux = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
    expect(isApplePlatform({ userAgent: mac })).toBe(true);
    expect(isApplePlatform({ userAgent: iphone })).toBe(true);
    expect(isApplePlatform({ userAgent: windows })).toBe(false);
    expect(isApplePlatform({ userAgent: linux })).toBe(false);
  });

  test("an empty userAgentData platform falls through to the string", () => {
    expect(isApplePlatform({ userAgent: "Macintosh", userAgentData: { platform: "" } })).toBe(true);
  });
});
