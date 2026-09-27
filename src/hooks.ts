import { getString, initLocale } from "./utils/locale";
import { registerMenus } from "./modules/menus";
import { registerPrefsScripts } from "./modules/prefsUI";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });

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
