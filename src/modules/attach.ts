export function sanitizeFileBaseName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- strips filesystem-illegal control characters
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "document";
}

export async function attachTranslation(opts: {
  parentItemID: number;
  filePath: string;
  title: string;
  fileBaseName: string;
}): Promise<Zotero.Item> {
  return Zotero.Attachments.importFromFile({
    file: opts.filePath,
    parentItemID: opts.parentItemID,
    title: opts.title,
    contentType: "application/pdf",
    fileBaseName: sanitizeFileBaseName(opts.fileBaseName),
  });
}
