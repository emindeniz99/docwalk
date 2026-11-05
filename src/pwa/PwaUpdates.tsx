import { useEffect, useState } from "react";
import { UNSTABLE_ToastQueue as ToastQueue } from "react-aria-components";
import { registerServiceWorker } from "./register";
import { UpdateToast, type UpdateToastContent } from "./UpdateToast";

/**
 * Registers the service worker and shows the update prompt when a new
 * version is waiting. Mounted by main.tsx in the main view of a production
 * build only; the presenter window and phone remote stay quiet.
 */
export function PwaUpdates() {
  const [queue] = useState(() => new ToastQueue<UpdateToastContent>({ maxVisibleToasts: 1 }));
  useEffect(() => {
    let shown: string | null = null;
    registerServiceWorker((apply) => {
      // A second update while the first prompt is open replaces it.
      if (shown) queue.close(shown);
      shown = queue.add({ apply });
    });
  }, [queue]);
  return <UpdateToast queue={queue} />;
}
