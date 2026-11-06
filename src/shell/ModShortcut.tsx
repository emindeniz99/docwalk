import { Command as CommandIcon } from "lucide-react";
import { isApplePlatform } from "./platform";

/** A Ctrl-or-⌘ shortcut as the viewer's keyboard labels it: ⌘K on Apple devices, Ctrl+K elsewhere. */
export function ModShortcut({ keyName }: { keyName: string }) {
  if (!isApplePlatform()) return <>Ctrl+{keyName}</>;
  return (
    <>
      <CommandIcon size={11} aria-hidden="true" />
      {keyName}
    </>
  );
}
