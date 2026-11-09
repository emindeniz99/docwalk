import { Trash } from "lucide-react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { m } from "../paraglide/messages.js";
import "./clearMarks.css";

interface ClearMarksDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Slides of the document with saved marks. */
  count: number;
  onConfirm: () => void;
}

/**
 * Asks before deleting the document's saved marks (decision 105). Cancel has
 * the focus, so an Enter on a dialog opened by mistake deletes nothing.
 */
export function ClearMarksDialog({
  isOpen,
  onOpenChange,
  count,
  onConfirm,
}: ClearMarksDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-marks-overlay"
    >
      <Modal className="docwalk-marks-modal">
        <Dialog role="alertdialog" className="docwalk-marks-dialog">
          {({ close }) => (
            <>
              <Heading slot="title" className="docwalk-marks-title">
                {m.marks_clear_title()}
              </Heading>
              <p className="docwalk-marks-body">{m.marks_clear_body({ count })}</p>
              <div className="docwalk-marks-actions">
                <Button
                  data-variant="primary"
                  className="docwalk-button"
                  onPress={() => {
                    close();
                    onConfirm();
                  }}
                >
                  <Trash size={16} aria-hidden="true" />
                  {m.marks_clear_confirm()}
                </Button>
                <Button slot="close" className="docwalk-button" autoFocus>
                  {m.cancel()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
