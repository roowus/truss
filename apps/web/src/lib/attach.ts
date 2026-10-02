/** Paste + drag-drop attach (issue #2 acceptance: "attach button + paste +
    drag-drop"). Both a clipboard paste and a drop carry their files on a
    DataTransfer, so one extractor serves both composer paths. */

/** Files carried by a paste/drop DataTransfer; empty when the transfer holds
    only text (a text paste must still land in the textarea). */
export function filesFromTransfer(dt: Pick<DataTransfer, "files"> | null | undefined): File[] {
  const files = dt?.files;
  return files && files.length ? Array.from(files) : [];
}

/** Whether a drag is carrying files — gates preventDefault on dragover so
    dragging selected text across the composer is not hijacked. */
export function isFileDrag(dt: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}
