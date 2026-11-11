import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MirrorFeed } from "../annotate/mirrorFeed";
import type { DeckController } from "../deck/controller";
import { m } from "../paraglide/messages.js";
import type { LevelOption } from "../sectioning/sectionize";
import type { Notice } from "../shell/useDocument";
import { startPresenterBridge } from "./bridge";
import { sameCountdown, type Countdown } from "./pacing";
import { openPresenterWindow } from "./window";

/**
 * The presenter window: opening it, and the bridge that answers it from this
 * tab. Only the tab that opened the window runs the bridge, so two open
 * docwalk tabs never both answer it.
 */
export function usePresenterWindow({
  controller,
  markdown,
  level,
  mirrorFeed,
  setNotice,
}: {
  controller: DeckController | null;
  markdown: string;
  level: LevelOption;
  mirrorFeed: MirrorFeed;
  setNotice: (notice: Notice | null) => void;
}) {
  const [presenterRequested, setPresenterRequested] = useState(false);
  // The presenter window's countdown, which phone remotes show (decision 112). A repeat of the
  // same values keeps the old object, so the window's 2 s heartbeat re-renders nothing.
  const [presenterCountdown, setPresenterCountdown] = useState<Countdown | null>(null);
  const onCountdown = useCallback(
    (next: Countdown | null) =>
      setPresenterCountdown((prev) => (sameCountdown(prev, next) ? prev : next)),
    [],
  );
  const startedAt = useRef(0);
  // The presenter bridge reads the latest document through refs, so it is not restarted on every keystroke.
  const markdownRef = useRef(markdown);
  const levelRef = useRef(level);
  useLayoutEffect(() => {
    markdownRef.current = markdown;
    levelRef.current = level;
  });

  useEffect(() => {
    if (!controller || !presenterRequested) return;
    return startPresenterBridge({
      getState: () => ({
        markdown: markdownRef.current,
        level: typeof levelRef.current === "object" ? [...levelRef.current] : levelRef.current,
        current: controller.current()?.address ?? "",
        addresses: controller.slides().map((sl) => sl.address),
        startedAt: startedAt.current,
      }),
      goTo: (address) => controller.goTo(address),
      step: (d) => (d === 1 ? controller.next() : controller.prev()),
      subscribe: (onChange) => controller.onChange(() => onChange()),
      mirror: mirrorFeed,
      onCountdown,
    });
  }, [controller, presenterRequested, mirrorFeed, onCountdown]);

  const openPresenter = useCallback(() => {
    if (!openPresenterWindow()) {
      setNotice({ message: m.app_presenter_blocked(), tone: "error" });
      return;
    }
    startedAt.current = Date.now();
    setPresenterRequested(true);
    setNotice(null);
  }, [setNotice]);

  return { presenterCountdown, openPresenter };
}
