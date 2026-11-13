import {
  Cast,
  KeyRound,
  ListChecks,
  LogIn,
  MonitorPlay,
  Search,
  Trash,
  type LucideIcon,
} from "lucide-react";
import { setEditorChoice, type EditorKind } from "../editor/choice";
import { chooseLocale, localeName, locales, type Locale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import type { LevelOption } from "../sectioning/sectionize";
import { workspaceCommands } from "../workspace/commands";
import type { Workspace } from "../workspace/useWorkspace";
import type { Command } from "./CommandPalette";
import type { MoreAction } from "./MoreMenu";
import { setPresentFrame, type PresentFrame } from "./presentChrome";
import type { ThemeChoice } from "./theme";
import type { View } from "./view";

const LEVELS: { label: string; value: LevelOption }[] = [
  { label: "H1", value: 1 },
  { label: "H2", value: 2 },
  { label: "H3", value: 3 },
];

export const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

interface Opener {
  open: () => void;
}

/** The command palette's commands, in the order it lists them. */
export function appCommands({
  present,
  openPresenter,
  overview,
  sectionPicker,
  layerReady,
  view,
  boardPage,
  toggleBoard,
  show,
  coarse,
  storedEditor,
  share,
  comments,
  saved,
  clearMarks,
  inputs,
  oauthClientId,
  signIn,
  remoteAvailable,
  openRemote,
  theme,
  setTheme,
  frame,
  resolved,
  setLevel,
  locale,
  workspace,
}: {
  present: () => Promise<void>;
  openPresenter: () => void;
  overview: Opener;
  sectionPicker: Opener;
  layerReady: number;
  view: View;
  boardPage: string | null;
  toggleBoard: () => void;
  show: (next: View) => void;
  coarse: boolean;
  storedEditor: EditorKind;
  share: Opener;
  comments: { command: Command | null };
  saved: { count: number };
  clearMarks: Opener;
  inputs: { setTokenOpen: (open: boolean) => void };
  oauthClientId: string | undefined;
  signIn: () => void;
  remoteAvailable: boolean;
  openRemote: () => void;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  frame: PresentFrame;
  resolved: string;
  setLevel: (level: LevelOption) => void;
  locale: Locale;
  workspace: Workspace;
}): Command[] {
  return [
    { id: "present", label: m.cmd_present(), run: () => void present() },
    { id: "presenter", label: m.cmd_presenter(), run: openPresenter },
    { id: "overview", label: m.cmd_overview(), hint: "O", run: overview.open },
    { id: "sections", label: m.cmd_sections(), run: sectionPicker.open },
    ...(layerReady > 0 && view !== "document"
      ? [
          boardPage !== null
            ? { id: "board-close", label: m.cmd_board_close(), hint: "W", run: toggleBoard }
            : { id: "board-open", label: m.cmd_board_open(), hint: "W", run: toggleBoard },
        ]
      : []),
    { id: "view-edit", label: m.cmd_show_editor(), run: () => show("edit") },
    { id: "view-document", label: m.cmd_show_document(), run: () => show("document") },
    // Touch screens keep CodeMirror and are not offered Monaco.
    ...(coarse
      ? []
      : [
          storedEditor === "monaco"
            ? {
                id: "editor-codemirror",
                label: m.cmd_editor({ editor: "CodeMirror" }),
                run: () => setEditorChoice("codemirror"),
              }
            : {
                id: "editor-monaco",
                label: m.cmd_editor({ editor: "Monaco" }),
                run: () => setEditorChoice("monaco"),
              },
        ]),
    { id: "share", label: m.cmd_share(), run: share.open },
    ...(comments.command ? [comments.command] : []),
    ...(saved.count > 0
      ? [{ id: "delete-marks", label: m.marks_clear_command(), run: clearMarks.open }]
      : []),
    { id: "token", label: m.cmd_token(), run: () => inputs.setTokenOpen(true) },
    ...(oauthClientId ? [{ id: "sign-in", label: m.cmd_sign_in(), run: signIn }] : []),
    ...(remoteAvailable ? [{ id: "remote", label: m.cmd_remote(), run: openRemote }] : []),
    {
      id: "theme",
      label: m.theme_switch({ next: NEXT_THEME[theme] }),
      run: () => setTheme(NEXT_THEME[theme]),
    },
    frame === "fill"
      ? { id: "frame-card", label: m.cmd_present_card(), run: () => setPresentFrame("card") }
      : { id: "frame-fill", label: m.cmd_present_fill(), run: () => setPresentFrame("fill") },
    {
      id: "level-auto",
      label: m.level_command({ level: m.level_auto_resolved({ resolved }) }),
      run: () => setLevel("auto"),
    },
    ...LEVELS.map((l) => ({
      id: `level-${String(l.value)}`,
      label: m.level_command({ level: l.label }),
      run: () => setLevel(l.value),
    })),
    // The language switch (decision 56) offers the languages not in use, each named in itself.
    ...locales
      .filter((l) => l !== locale)
      .map((l: Locale) => ({
        id: `locale-${l}`,
        label: m.cmd_language({ language: localeName(l) }),
        run: () => chooseLocale(l),
      })),
    ...workspaceCommands(workspace),
  ];
}

/** The More menu's actions; on a phone it also takes the palette trigger and the theme. */
export function appMoreActions({
  phone,
  setPaletteOpen,
  inputs,
  oauthClientId,
  signIn,
  remoteAvailable,
  openRemote,
  openPresenter,
  sectionPicker,
  comments,
  saved,
  clearMarks,
  theme,
  setTheme,
  ThemeIcon,
}: {
  phone: boolean;
  setPaletteOpen: (open: boolean) => void;
  inputs: { setTokenOpen: (open: boolean) => void };
  oauthClientId: string | undefined;
  signIn: () => void;
  remoteAvailable: boolean;
  openRemote: () => void;
  openPresenter: () => void;
  sectionPicker: Opener;
  comments: { moreAction: MoreAction | null };
  saved: { count: number };
  clearMarks: Opener;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  ThemeIcon: LucideIcon;
}): MoreAction[] {
  return [
    ...(phone
      ? [
          {
            id: "palette",
            label: m.cmd_palette(),
            Icon: Search,
            run: () => setPaletteOpen(true),
          },
        ]
      : []),
    { id: "token", label: m.cmd_token(), Icon: KeyRound, run: () => inputs.setTokenOpen(true) },
    ...(oauthClientId ? [{ id: "sign-in", label: m.cmd_sign_in(), Icon: LogIn, run: signIn }] : []),
    ...(remoteAvailable
      ? [{ id: "remote", label: m.cmd_remote(), Icon: Cast, run: openRemote }]
      : []),
    { id: "presenter", label: m.cmd_presenter(), Icon: MonitorPlay, run: openPresenter },
    { id: "sections", label: m.cmd_sections(), Icon: ListChecks, run: sectionPicker.open },
    ...(comments.moreAction ? [comments.moreAction] : []),
    ...(saved.count > 0
      ? [{ id: "delete-marks", label: m.marks_clear_command(), Icon: Trash, run: clearMarks.open }]
      : []),
    ...(phone
      ? [
          {
            id: "theme",
            label: m.theme_switch({ next: NEXT_THEME[theme] }),
            Icon: ThemeIcon,
            run: () => setTheme(NEXT_THEME[theme]),
          },
        ]
      : []),
  ];
}
