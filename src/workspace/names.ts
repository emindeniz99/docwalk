/**
 * File names and paths in the workspace. Names come from the user and from
 * zip archives, so they are hostile (AGENTS.md rule 5): a zip entry named
 * `../../x.md` must never reach outside the workspace, and a name the
 * platform would reject is refused here with a readable message instead of
 * a DOMException.
 */

/** Characters no workspace name may contain: separators, and what Windows forbids. */
const FORBIDDEN = /[/\\:*?"<>|]/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why `name` cannot be a file or folder name, or `null` when it can. */
export function validateName(name: string): string | null {
  if (name.trim() === "") return "Enter a name.";
  if (name !== name.trim()) return "A name cannot start or end with a space.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (name.length > 255) return "Use a name of 255 characters or fewer.";
  if (FORBIDDEN.test(name)) return 'A name cannot contain / \\ : * ? " < > or |.';
  if (CONTROL.test(name)) return "A name cannot contain control characters.";
  if (name.endsWith(".")) return "A name cannot end with a dot.";
  return null;
}

/** Files docwalk opens as documents. */
export function isDocumentName(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

/** `plan` becomes `plan.md`; a name that already has an extension keeps it. */
export function withMarkdownExtension(name: string): string {
  return /\.[^.]+$/.test(name) ? name : `${name}.md`;
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** The folder that holds `path`; `""` for the root. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every folder above `path`, outermost first: `a/b/c.md` gives `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** True when `path` is `base` or lies inside it. */
export function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * A zip entry name as a safe workspace path, or `null` when it would escape
 * the root or holds a name the workspace refuses. Backslashes count as
 * separators (archives made on Windows), and empty and `.` segments are
 * dropped, so `/abs.md` and `./a.md` land inside the root.
 */
export function safeArchivePath(raw: string): string | null {
  const parts = raw
    .replaceAll("\\", "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return null;
  for (const part of parts) if (part === ".." || validateName(part) !== null) return null;
  return parts.join("/");
}

/** `name`, or `name 2`, `name 3`... before the extension, whichever is not in `taken`. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
