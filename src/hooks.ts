import { getString, initLocale } from "./utils/locale";
import { registerMenus } from "./modules/menus";
import { registerPrefsScripts } from "./modules/prefsUI";
import { cleanupStaleWorkDirs } from "./modules/runner";
import { translateQueue } from "./modules/queue";

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

  void cleanupStaleWorkDirs();
  void runStartupDiagnostics();
}

// Writes a pane-loading diagnostic report to the data directory when the
// debugProbe pref is on. Exercises exactly what the preferences window
// does (read pane src -> parseXULToFragment) so a failing pane can be
// diagnosed from the JSON alone.
async function runStartupDiagnostics(): Promise<void> {
  try {
    if (
      Zotero.Prefs.get(`${addon.data.config.prefsPrefix}.debugProbe`, true) !==
      true
    ) {
      return;
    }
    await Zotero.Promise.delay(15000);
    const result: any = {
      time: new Date().toISOString(),
      paneId: prefPaneId,
      steps: {},
    };
    const src = rootURI + "content/preferences.xhtml";
    let markup: string | null = null;
    try {
      markup = Zotero.File.getContentsFromURL(src);
      result.steps.read = { ok: true, length: markup.length };
    } catch (e: any) {
      result.steps.read = {
        ok: false,
        error: String(e),
        stack: String(e?.stack || "").slice(0, 3000),
      };
    }
    if (markup != null) {
      try {
        const win = Zotero.getMainWindows()[0];
        const frag = win.MozXULElement.parseXULToFragment(markup, [
          "chrome://zotero/locale/zotero.dtd",
          "chrome://zotero/locale/preferences.dtd",
        ]);
        result.steps.parse = { ok: true, childCount: frag.childElementCount };
      } catch (e: any) {
        result.steps.parse = {
          ok: false,
          error: String(e),
          stack: String(e?.stack || "").slice(0, 3000),
        };
      }
    }
    // The side-by-side merger loads this script at translate time; a jar:
    // install has no disk path, so verify the URL loader can serve it.
    try {
      const scriptContent = Zotero.File.getContentsFromURL(
        rootURI + "content/side_by_side.py",
      );
      result.steps.scriptRead = { ok: true, length: scriptContent.length };
    } catch (e: any) {
      result.steps.scriptRead = {
        ok: false,
        error: String(e),
        stack: String(e?.stack || "").slice(0, 1500),
      };
    }

    // End-to-end: open the real preferences window, click our pane, and
    // check whether the pane content actually renders.
    try {
      const win = Zotero.getMainWindows()[0];
      const prefsWin: any = win.openDialog(
        "chrome://zotero/content/preferences/preferences.xhtml",
        "zotero-prefs",
        "chrome,titlebar,toolbar=center,resizable",
      );
      for (let i = 0; i < 40; i++) {
        if (prefsWin?.document?.readyState === "complete") break;
        await Zotero.Promise.delay(500);
      }
      await Zotero.Promise.delay(1500);
      const step: any = {};
      result.steps.prefsWindow = step;
      const doc = prefsWin?.document;
      step.opened = !!doc;
      const nav = doc?.getElementById("prefs-navigation");
      step.navFound = !!nav;
      const item = nav?.querySelector(
        'richlistitem[value="fullpdf-prefs"]',
      ) as any;
      step.paneItemFound = !!item;
      const errors: string[] = [];
      if (doc?.defaultView) {
        doc.defaultView.addEventListener("error", (e: any) =>
          errors.push("error: " + String(e?.message ?? e).slice(0, 300)),
        );
        doc.defaultView.addEventListener("unhandledrejection", (e: any) =>
          errors.push("rejection: " + String(e?.reason ?? e).slice(0, 300)),
        );
      }
      if (item) {
        item.click();
        await Zotero.Promise.delay(5000);
        step.clicked = true;
        step.rendered = !!doc.getElementById("zotero-prefpane-fullpdf");
        step.errors = errors;
      }
      try {
        prefsWin.close();
      } catch {
        // ignore
      }
    } catch (e: any) {
      result.steps.prefsWindow = {
        fatal: String(e),
        stack: String(e?.stack || "").slice(0, 2000),
      };
    }

    const out = PathUtils.join(
      Zotero.DataDirectory.dir,
      `${addon.data.config.addonRef}-diagnostics.json`,
    );
    await Zotero.File.putContentsAsync(out, JSON.stringify(result, null, 2));
    Zotero.debug(`[fullpdf] diagnostics written to ${out}`);
  } catch (e: any) {
    Zotero.logError(e);
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // The toolkit instance is created once in the Addon constructor and
  // reused: recreating it per window dropped the previous instance on
  // the floor, so its registrations could never be unregistered.
  // (No per-window FTL needed: menu labels go through getString(), and
  // the preferences pane declares its own localization linkset.)

  addon.data.menuCleanups.set(win, registerMenus(win));
}

function onMainWindowUnload(win: Window): void {
  // Zotero supports multiple main windows; closing one must not leave
  // its menu items and listeners behind.
  const cleanup = addon.data.menuCleanups.get(win);
  if (cleanup) {
    try {
      cleanup();
    } catch {
      // best effort
    }
    addon.data.menuCleanups.delete(win);
  }
}

function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") {
    registerPrefsScripts(data.window);
  }
}

// Minimal teardown used by bootstrap.js even on APP_SHUTDOWN, when the
// full onShutdown below is skipped: stop the queue and kill the engine
// process, because Windows does not terminate child processes when the
// parent exits — quitting Zotero would leave the engine running orphaned.
function stopTranslations(): void {
  translateQueue.stop();
}

function onShutdown(): void {
  translateQueue.stop();
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
  for (const cleanup of addon.data.menuCleanups.values()) {
    try {
      cleanup();
    } catch {
      // best effort
    }
  }
  addon.data.menuCleanups.clear();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  stopTranslations,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
