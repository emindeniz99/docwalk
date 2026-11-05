/**
 * Zip import and export for the workspace (decision 57), on fflate, which
 * loads only when the user imports or exports.
 *
 * An archive is hostile input (rule 5). Entry names go through
 * `safeArchivePath`, so `../` and absolute paths never leave the target
 * folder; entries are inflated as a stream in small slices and counted, so a
 * zip bomb is stopped at the cap instead of filling memory; only document
 * files (`.md`, `.markdown`, `.txt`) are kept, each under the 2 MB document
 * cap. Nothing is decoded or rendered here: an imported file is checked as
 * UTF-8 and sanitized when it is opened, like any other.
 */
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import { WorkspaceError } from "./errors";
import { isDocumentName, safeArchivePath } from "./names";

/** Largest zip file read. */
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
/** Most bytes all kept files may inflate to. */
export const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;
/** Most entries an archive may hold. */
export const MAX_ARCHIVE_ENTRIES = 2000;
/** Input is fed to the inflater in slices this big, so no single output chunk can be huge. */
const SLICE = 16 * 1024;

export interface ArchiveContents {
  files: { path: string; data: Uint8Array<ArrayBuffer> }[];
  folders: string[];
  /** Entries left out: not a document, too large, hidden, or with an unsafe name. */
  skipped: number;
}

/** Hidden entries (`.git/`, `._file.md` resource forks) and macOS archive metadata. */
function hidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX");
}

function concat(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function readArchive(bytes: Uint8Array): Promise<ArchiveContents> {
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new WorkspaceError(`The zip file is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
  }
  const { Unzip, UnzipInflate } = await import("fflate");
  const result: ArchiveContents = { files: [], folders: [], skipped: 0 };
  let failure: WorkspaceError | null = null;
  let entries = 0;
  let unpacked = 0;

  const unzip = new Unzip((entry) => {
    if (failure) return;
    if (++entries > MAX_ARCHIVE_ENTRIES) {
      failure = new WorkspaceError(`The zip file has more than ${MAX_ARCHIVE_ENTRIES} entries.`);
      return;
    }
    const isFolder = entry.name.endsWith("/") || entry.name.endsWith("\\");
    const path = safeArchivePath(entry.name);
    if (path === null || hidden(path)) {
      if (!isFolder) result.skipped++;
      return;
    }
    if (isFolder) {
      result.folders.push(path);
      return;
    }
    if (!isDocumentName(path)) {
      result.skipped++;
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let dropped = false;
    entry.ondata = (error, chunk, final) => {
      if (failure || dropped) return;
      if (error) {
        failure = new WorkspaceError("The zip file is damaged.");
        return;
      }
      size += chunk.length;
      unpacked += chunk.length;
      if (unpacked > MAX_UNPACKED_BYTES) {
        failure = new WorkspaceError(
          `The zip file unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB.`,
        );
        entry.terminate();
        return;
      }
      if (size > MAX_DOCUMENT_BYTES) {
        dropped = true;
        result.skipped++;
        entry.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) result.files.push({ path, data: concat(chunks, size) });
    };
    entry.start();
  });
  unzip.register(UnzipInflate);

  // The callbacks above run synchronously inside push(), so a failure stops the loop.
  const failed = () => failure !== null;
  try {
    for (let i = 0; i < bytes.length && !failed(); i += SLICE) {
      unzip.push(bytes.subarray(i, i + SLICE), i + SLICE >= bytes.length);
    }
  } catch {
    throw new WorkspaceError("The file is not a zip archive, or it is damaged.");
  }
  if (failure) throw failure;
  return result;
}

/** A zip of the given files; folders get their own entries so empty ones survive. */
export async function buildArchive(
  files: { path: string; data: Uint8Array }[],
  folders: string[],
): Promise<Blob> {
  const { zipSync } = await import("fflate");
  const entries: Record<string, Uint8Array> = {};
  for (const folder of folders) entries[`${folder}/`] = new Uint8Array(0);
  for (const file of files) entries[file.path] = file.data;
  const zipped = zipSync(entries, { level: 6 });
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}
