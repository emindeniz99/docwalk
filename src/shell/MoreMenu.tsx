import { Check, Ellipsis, ImageOff, PanelTopDashed, type LucideIcon } from "lucide-react";
import {
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Separator,
} from "react-aria-components";
import { COARSE_POINTER, setEditorChoice, useStoredEditorChoice } from "../editor/choice";
import { chooseLocale, localeName, locales, useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { setLoadRemoteImages, useLoadRemoteImages } from "../render/remoteImages";
import { IconButton } from "./IconButton";
import { setKeepChromeVisible, useKeepChromeVisible } from "./presentChrome";
import { useMediaQuery } from "./useMediaQuery";

export interface MoreAction {
  id: string;
  label: string;
  Icon: LucideIcon;
  run: () => void;
}

const LOAD_REMOTE_IMAGES = "load-remote-images";
const KEEP_CONTROLS = "keep-present-controls";

/** Secondary header actions in one React Aria menu, so the header fits a phone. */
export function MoreMenu({ actions }: { actions: MoreAction[] }) {
  const loadRemoteImages = useLoadRemoteImages();
  const keepControls = useKeepChromeVisible();
  const editor = useStoredEditorChoice();
  const coarse = useMediaQuery(COARSE_POINTER);
  const locale = useLocale();
  return (
    <MenuTrigger>
      <IconButton label={m.more_actions()}>
        <Ellipsis size={18} aria-hidden="true" />
      </IconButton>
      <Popover className="docwalk-popover" placement="bottom end">
        <Menu
          aria-label={m.more_actions()}
          className="docwalk-menu docwalk-more-menu"
          onAction={(key) => actions.find((a) => a.id === key)?.run()}
        >
          <MenuSection items={actions}>
            {({ id, label, Icon }) => (
              <MenuItem id={id} textValue={label} className="docwalk-menu-item">
                <Icon size={16} aria-hidden="true" />
                {label}
              </MenuItem>
            )}
          </MenuSection>
          {/* Checkbox items (decision 33's "always load" setting, decision 75's
              presenting controls), so their state is announced. */}
          <MenuSection
            selectionMode="multiple"
            selectedKeys={[
              ...(loadRemoteImages ? [LOAD_REMOTE_IMAGES] : []),
              ...(keepControls ? [KEEP_CONTROLS] : []),
            ]}
            onSelectionChange={(keys) => {
              const on = (key: string) => keys === "all" || keys.has(key);
              if (on(LOAD_REMOTE_IMAGES) !== loadRemoteImages)
                setLoadRemoteImages(on(LOAD_REMOTE_IMAGES));
              if (on(KEEP_CONTROLS) !== keepControls) setKeepChromeVisible(on(KEEP_CONTROLS));
            }}
          >
            <MenuItem
              id={LOAD_REMOTE_IMAGES}
              textValue={m.more_remote_images()}
              className="docwalk-menu-item"
            >
              {({ isSelected }) => (
                <>
                  {isSelected ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <ImageOff size={16} aria-hidden="true" />
                  )}
                  {m.more_remote_images()}
                </>
              )}
            </MenuItem>
            <MenuItem
              id={KEEP_CONTROLS}
              textValue={m.more_keep_controls()}
              className="docwalk-menu-item"
            >
              {({ isSelected }) => (
                <>
                  {isSelected ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <PanelTopDashed size={16} aria-hidden="true" />
                  )}
                  {m.more_keep_controls()}
                </>
              )}
            </MenuItem>
          </MenuSection>
          {/* Radio items (decision 53), so the current editor is announced; touch
              screens keep CodeMirror and never see the choice. */}
          {!coarse && <Separator className="docwalk-menu-separator" />}
          {!coarse && (
            <MenuSection
              aria-label={m.more_editor()}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[editor]}
              onSelectionChange={(keys) => {
                const [key] = keys === "all" ? [] : [...keys];
                if (key === "codemirror" || key === "monaco") setEditorChoice(key);
              }}
            >
              <Header className="docwalk-menu-header">{m.more_editor()}</Header>
              <MenuItem
                id="codemirror"
                textValue="CodeMirror"
                className="docwalk-menu-item docwalk-menu-item-inset"
              >
                CodeMirror
              </MenuItem>
              <MenuItem
                id="monaco"
                textValue="Monaco"
                className="docwalk-menu-item docwalk-menu-item-inset"
              >
                Monaco
              </MenuItem>
            </MenuSection>
          )}
          {/* Radio items (decision 56): the language in use is announced, and a
              switch keeps the draft and the slide (decision 30). */}
          <Separator className="docwalk-menu-separator" />
          <MenuSection
            aria-label={m.more_language()}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[locale]}
            onSelectionChange={(keys) => {
              const [key] = keys === "all" ? [] : [...keys];
              const next = locales.find((l) => l === key);
              if (next) chooseLocale(next);
            }}
          >
            <Header className="docwalk-menu-header">{m.more_language()}</Header>
            {locales.map((l) => (
              <MenuItem
                key={l}
                id={l}
                textValue={localeName(l)}
                lang={l}
                className="docwalk-menu-item docwalk-menu-item-inset"
              >
                {localeName(l)}
              </MenuItem>
            ))}
          </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
