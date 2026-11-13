import { useCallback, useState } from "react";

/** Mounts a lazily loaded dialog on first open and keeps it mounted, so closing animates and restores focus. */
export function useLazyDialog() {
  const [isOpen, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setMounted(true);
    setOpen(open);
  }, []);
  return { isOpen, mounted, onOpenChange, open: () => onOpenChange(true) };
}
