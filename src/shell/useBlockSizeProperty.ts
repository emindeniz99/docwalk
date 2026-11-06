import { useCallback } from "react";

/**
 * A ref that publishes its element's height as a custom property on the
 * root element, for fixed layers that must clear it. The status bar wraps
 * to more lines on a phone, so the update prompt cannot assume one height;
 * a hidden element (presenting) reports 0.
 */
export function useBlockSizeProperty<T extends HTMLElement>(name: `--${string}`) {
  return useCallback(
    (element: T | null) => {
      if (!element) return;
      const root = document.documentElement;
      const observer = new ResizeObserver(([entry]) => {
        const size = entry?.borderBoxSize[0]?.blockSize ?? element.offsetHeight;
        root.style.setProperty(name, `${size}px`);
      });
      observer.observe(element);
      return () => {
        observer.disconnect();
        root.style.removeProperty(name);
      };
    },
    [name],
  );
}
