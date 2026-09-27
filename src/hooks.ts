import { getString, initLocale } from "./utils/locale";
import { registerMenus } from "./modules/menus";
import { registerPrefsScripts } from "./modules/prefsUI";
import { createZToolkit } from "./utils/ztoolkit";

// Returned by Zotero.PreferencePanes.register; used to unregister on
// shutdown as a belt-and-braces complement to Zotero's own cleanup.
let prefPaneId: string | null = null;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  try {
    // A stable pane id makes registration idempotent: re-registering in
    // the same session (e.g. update installed without restart) throws
    // "already registered" instead of stacking a duplicate entry.
    prefPaneId = await Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: rootURI + "content/preferences.xhtml",
      id: `${addon.data.config.addonRef}-prefs`,
      label: getString("prefs-title"),
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    });
  } catch (e: any) {
    if (!/already registered/i.test(String(e?.message ?? e))) {
      Zotero.logError(e);
    }
  }

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  addon.data.menuCleanups.push(registerMenus(win));
}

function onMainWindowUnload(_win: Window): void {
  // Menu cleanup happens in onShutdown; the main window going away
  // always coincides with plugin shutdown in practice.
}

function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") {
    registerPrefsScripts(data.window);
  }
}

function onShutdown(): void {
  if (prefPaneId) {
    try {
      Zotero.PreferencePanes.unregister(prefPaneId);
    } catch {
      // Zotero also removes panes by pluginID on shutdown
    }
    prefPaneId = null;
  }
  try {
    addon.data.currentProc?.kill();
  } catch {
    // nothing running
  }
  for (const cleanup of addon.data.menuCleanups) {
    try {
      cleanup();
    } catch {
      // best effort
    }
  }
  addon.data.menuCleanups = [];
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
