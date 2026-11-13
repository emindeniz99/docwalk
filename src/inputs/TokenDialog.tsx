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
import { rich } from "../i18n/rich";
import { m } from "../paraglide/messages.js";
import "./inputs.css";
import { clearToken, parseToken, readToken, storePastedToken } from "./token";

/** GitHub's page for a new fine-grained token, and the list to review or revoke them (decision 35). */
const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const TOKENS_URL = "https://github.com/settings/personal-access-tokens";

interface TokenDialogProps {
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
      setError(m.token_invalid());
      return;
    }
    if (!storePastedToken(token)) {
      setError(m.token_storage_blocked());
      return;
    }
    setValue("");
    setError(null);
    setHasToken(true);
    setStatus(m.token_saved());
    onTokenChange?.(token);
  };

  const forget = () => {
    clearToken();
    setHasToken(false);
    // The pressed button is about to be disabled; keep keyboard focus inside the dialog.
    inputRef.current?.focus();
    setStatus(m.token_forgotten());
    onTokenChange?.(null);
  };

  return (
    <>
      <Heading slot="title">
        <KeyRound size={20} aria-hidden="true" />
        {m.token_title()}
      </Heading>
      <p>{m.token_intro()}</p>
      {/* GitHub's own labels stay as GitHub shows them (in English). */}
      <ol>
        <li>{rich(m.token_step_repo, { option: <strong>Only select repositories</strong> })}</li>
        <li>
          {rich(m.token_step_permissions, { permission: <strong>Contents: Read-only</strong> })}
        </li>
      </ol>
      <Link href={NEW_TOKEN_URL} target="_blank" rel="noreferrer noopener">
        {m.token_create_link()}
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
          <Label>{m.token_field()}</Label>
          <Input
            ref={inputRef}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="github_pat_…"
          />
          <Text slot="description" className="docwalk-inputs-hint">
            {hasToken ? m.token_saved_hint() : m.token_none_hint()}
          </Text>
          <FieldError className="docwalk-inputs-error">{error}</FieldError>
        </TextField>
        <div className="docwalk-inputs-actions">
          <Button
            type="submit"
            data-variant="primary"
            className="docwalk-button docwalk-inputs-target"
          >
            {m.token_save()}
          </Button>
          <Button
            isDisabled={!hasToken}
            onPress={forget}
            className="docwalk-button docwalk-inputs-target"
          >
            {m.token_forget()}
          </Button>
          <Button slot="close" className="docwalk-button docwalk-inputs-target">
            {m.close()}
          </Button>
        </div>
      </Form>
      <p role="status" className="docwalk-inputs-status">
        {status}
      </p>
      <Link href={TOKENS_URL} target="_blank" rel="noreferrer noopener">
        {m.token_review_link()}
        <ExternalLink size={14} aria-hidden="true" />
      </Link>
    </>
  );
}
