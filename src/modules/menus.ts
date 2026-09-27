import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getSelectedItems, selectionHasPdf } from "./items";
import { translateQueue } from "./queue";

// Registers right-click menu entries on the item and collection menus of
// one main window. Returns a cleanup function.
export function registerMenus(win: Window): () => void {
  const doc = win.document;
  const cleanups: Array<() => void> = [];

  const itemMenu = doc.getElementById("zotero-itemmenu");
  if (itemMenu) {
    const mi = doc.createXULElement("menuitem");
    mi.id = `${config.addonRef}-itemmenu-translate`;
    mi.setAttribute("label", getString("itemmenu-translate"));
    mi.addEventListener("command", () => {
      void translateQueue.addFromItems(getSelectedItems(win));
    });
    const onPopupShowing = () => {
      if (selectionHasPdf(win)) mi.removeAttribute("hidden");
      else mi.setAttribute("hidden", "true");
    };
    itemMenu.appendChild(mi);
    itemMenu.addEventListener("popupshowing", onPopupShowing);
    cleanups.push(() => {
      itemMenu.removeEventListener("popupshowing", onPopupShowing);
      mi.remove();
    });
  }

  const colMenu = doc.getElementById("zotero-collectionmenu");
  if (colMenu) {
    const cmi = doc.createXULElement("menuitem");
    cmi.id = `${config.addonRef}-collectionmenu-translate`;
    cmi.setAttribute("label", getString("collectionmenu-translate"));
    cmi.addEventListener("command", () => {
      const col = (win as any).ZoteroPane?.getSelectedCollection?.();
      if (col) void translateQueue.addFromCollection(col);
    });
    colMenu.appendChild(cmi);
    cleanups.push(() => cmi.remove());
  }

  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // cleanup is best effort
      }
    }
  };
}
