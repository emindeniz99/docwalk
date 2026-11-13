/** What the browser says about its platform: `userAgentData` (Chromium) first, the user agent string otherwise. */
interface PlatformHints {
  userAgent: string;
  userAgentData?: { platform: string } | undefined;
}

const APPLE_PLATFORMS = new Set(["macOS", "iOS"]);

/**
 * Whether the keyboard has a Command key. Shortcut hints name the key the
 * viewer presses: ⌘ on a Mac, iPhone or iPad, Ctrl everywhere else (the
 * handlers accept either). iPadOS asks for desktop sites as "Macintosh", so
 * the string test covers it too.
 */
export function isApplePlatform(
  hints: PlatformHints = globalThis.navigator as unknown as PlatformHints,
): boolean {
  const platform = hints.userAgentData?.platform;
  if (platform) return APPLE_PLATFORMS.has(platform);
  return /Mac|iPhone|iPad|iPod/.test(hints.userAgent);
}
