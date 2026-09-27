export interface PdfSource {
  source: Zotero.Item;
  parent: Zotero.Item;
}

export function isPdfAttachment(item: Zotero.Item | null | undefined): boolean {
  return (
    !!item &&
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf"
  );
}

export function getSelectedItems(win: Window): Zotero.Item[] {
  try {
    return (win as any).ZoteroPane?.getSelectedItems?.() ?? [];
  } catch {
    return [];
  }
}

function firstPdfAttachment(item: Zotero.Item): Zotero.Item | null {
  for (const id of item.getAttachments()) {
    const att = Zotero.Items.get(id);
    if (isPdfAttachment(att)) return att;
  }
  return null;
}

export async function collectPdfSourcesFromItems(
  items: Zotero.Item[],
): Promise<PdfSource[]> {
  const out: PdfSource[] = [];
  const seen = new Set<number>();
  const push = (source: Zotero.Item, parent: Zotero.Item) => {
    if (seen.has(source.id)) return;
    seen.add(source.id);
    out.push({ source, parent });
  };
  for (const item of items ?? []) {
    if (!item) continue;
    if (item.isRegularItem()) {
      let best: Zotero.Item | null = null;
      try {
        best = (await item.getBestAttachment()) || null;
      } catch {
        best = null;
      }
      if (!isPdfAttachment(best)) best = firstPdfAttachment(item);
      if (best) push(best, item);
    } else if (isPdfAttachment(item)) {
      const parent = item.parentItem;
      // Standalone attachments without a parent have nowhere to attach
      // the translated result, so skip them.
      if (parent) push(item, parent);
    }
  }
  return out;
}

export async function collectPdfSourcesFromCollection(
  collection: Zotero.Collection,
): Promise<PdfSource[]> {
  const items: Zotero.Item[] = [];
  const walk = (col: Zotero.Collection) => {
    for (const child of col.getChildItems(false) ?? []) {
      if (child.isRegularItem()) items.push(child);
    }
    for (const sub of col.getChildCollections() ?? []) walk(sub);
  };
  walk(collection);
  return collectPdfSourcesFromItems(items);
}

export function selectionHasPdf(win: Window): boolean {
  const items = getSelectedItems(win);
  if (!items.length) return false;
  return items.some((item) => {
    if (item.isRegularItem()) {
      return item
        .getAttachments()
        .some((id) => isPdfAttachment(Zotero.Items.get(id)));
    }
    return isPdfAttachment(item);
  });
}
