import { useEffect, useState } from "react";
import { UNSTABLE_ToastQueue as ToastQueue } from "react-aria-components";
import { consumeLaunchedFile, openLikeADrop } from "./launch";
import { registerServiceWorker } from "./register";
import { UpdateToast, type UpdateToastContent } from "./UpdateToast";

/**
 * Registers the service worker, shows the update prompt when a new version
 * is waiting, and opens a Markdown file the OS launched the app with
 * (decision 99). Mounted by main.tsx in the main view of a production
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
    consumeLaunchedFile(openLikeADrop);
  }, [queue]);
  return <UpdateToast queue={queue} />;
}
