import { ExternalLink, KeyRound } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  FieldError,
  Form,
  Heading,
  Input,
  Label,
  Link,
  Modal,
  ModalOverlay,
  Text,
  TextField,
} from "react-aria-components";
import "./inputs.css";
import { clearToken, parseToken, readToken, storePastedToken } from "./token";

/** GitHub's page for a new fine-grained token, and the list to review or revoke them (decision 35). */
export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
export const TOKENS_URL = "https://github.com/settings/personal-access-tokens";

export interface TokenDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The token now in effect: the saved one, or null after "Forget token". */
  onTokenChange?: (token: string | null) => void;
}

/**
 * Paste a fine-grained GitHub token to read private repositories. The field
 * is write-only: a saved token is never shown again, only forgotten.
 */
export function TokenDialog({ isOpen, onOpenChange, onTokenChange }: TokenDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-inputs-overlay"
    >
      <Modal className="docwalk-inputs-modal">
        <Dialog className="docwalk-inputs-dialog">
          <TokenForm onTokenChange={onTokenChange} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The dialog's content; the Modal mounts it on every open, so its state starts fresh each time. */
function TokenForm({
  onTokenChange,
}: {
  onTokenChange?: TokenDialogProps["onTokenChange"] | undefined;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [hasToken, setHasToken] = useState(() => readToken() !== null);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = parseToken(value);
    if (token === null) {
      setError("That does not look like a GitHub token. Paste the whole token.");
      return;
    }
    if (!storePastedToken(token)) {
      setError("This browser blocks session storage, so the token cannot be kept.");
      return;
    }
    setValue("");
    setError(null);
    setHasToken(true);
    setStatus("Token saved for this tab. Closing the tab forgets it.");
    onTokenChange?.(token);
  };

  const forget = () => {
    clearToken();
    setHasToken(false);
    // The pressed button is about to be disabled; keep keyboard focus inside the dialog.
    inputRef.current?.focus();
    setStatus("Token forgotten. Revoke it on GitHub too if you no longer need it.");
    onTokenChange?.(null);
  };

  return (
    <>
      <Heading slot="title">
        <KeyRound size={20} aria-hidden="true" />
        GitHub access token
      </Heading>
      <p>
        A token lets docwalk read Markdown from private repositories. It stays in this browser tab
        (session storage) and is sent only to api.github.com.
      </p>
      <ol>
        <li>
          Create a fine-grained token. Under Repository access choose{" "}
          <strong>Only select repositories</strong>.
        </li>
        <li>
          Under Permissions set <strong>Contents: Read-only</strong>. Nothing else is needed.
        </li>
      </ol>
      <Link href={NEW_TOKEN_URL} target="_blank" rel="noreferrer noopener">
        Create a token on GitHub
        <ExternalLink size={14} aria-hidden="true" />
      </Link>
      <Form onSubmit={save} className="docwalk-inputs-form">
        <TextField
          type="password"
          value={value}
          onChange={(next) => {
            setValue(next);
            setError(null);
          }}
          isInvalid={error !== null}
          autoComplete="off"
          className="docwalk-inputs-field"
        >
          <Label>Fine-grained token</Label>
          <Input
            ref={inputRef}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="github_pat_…"
          />
          <Text slot="description" className="docwalk-inputs-hint">
            {hasToken ? "A token is saved for this tab." : "No token saved."}
          </Text>
          <FieldError className="docwalk-inputs-error">{error}</FieldError>
        </TextField>
        <div className="docwalk-inputs-actions">
          <Button
            type="submit"
            data-variant="primary"
            className="docwalk-button docwalk-inputs-target"
          >
            Save token
          </Button>
          <Button
            isDisabled={!hasToken}
            onPress={forget}
            className="docwalk-button docwalk-inputs-target"
          >
            Forget token
          </Button>
          <Button slot="close" className="docwalk-button docwalk-inputs-target">
            Close
          </Button>
        </div>
      </Form>
      <p role="status" className="docwalk-inputs-status">
        {status}
      </p>
      <Link href={TOKENS_URL} target="_blank" rel="noreferrer noopener">
        Review or revoke your tokens on GitHub
        <ExternalLink size={14} aria-hidden="true" />
      </Link>
    </>
  );
}
