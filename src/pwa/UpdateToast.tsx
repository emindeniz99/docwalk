import { RefreshCw, X } from "lucide-react";
import {
  Button,
  Text,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
} from "react-aria-components";
import { IconButton } from "../shell/IconButton";
import "./update.css";

export interface UpdateToastContent {
  /** Hands control to the waiting service worker and reloads the page. */
  apply: () => void;
}

/**
 * The "update available" prompt (decision 11). A toast, not a dialog: it
 * never takes focus or blocks the deck, so it cannot interrupt a talk; the
 * region is a labelled landmark that announces the toast. It stays until the
 * user reloads or dismisses it, because the update is not urgent.
 */
export function UpdateToast({ queue }: { queue: ToastQueue<UpdateToastContent> }) {
  return (
    <ToastRegion queue={queue} className="docwalk-toast-region" aria-label="Notifications">
      {({ toast }) => (
        <Toast toast={toast} className="docwalk-toast">
          <RefreshCw className="docwalk-toast-icon" size={18} aria-hidden="true" />
          <ToastContent className="docwalk-toast-content">
            <Text slot="title" className="docwalk-toast-title">
              Update ready
            </Text>
            <Text slot="description" className="docwalk-toast-description">
              Reload to use the new version of docwalk.
            </Text>
          </ToastContent>
          <Button
            className="docwalk-button"
            data-variant="primary"
            onPress={() => toast.content.apply()}
          >
            Reload
          </Button>
          <IconButton label="Dismiss" slot="close">
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Toast>
      )}
    </ToastRegion>
  );
}
