// Installs minimal globals so modules that reference Zotero/PathUtils/
// IOUtils at call time can be imported and exercised under plain Node.
// Only what the tested modules touch is stubbed.

const PREFIX = "extensions.zotero.fullpdf";

export interface GlobalsHandle {
  setPref(key: string, value: unknown): void;
  getPref(key: string): unknown;
  debugCalls: string[];
}

export function installGlobals(
  initialPrefs: Record<string, unknown> = {},
): GlobalsHandle {
  const store: Record<string, unknown> = { ...initialPrefs };
  const debugCalls: string[] = [];
  const g = globalThis as any;
  g.Zotero = {
    Prefs: {
      get(name: string) {
        return store[
          name.startsWith(PREFIX) ? name.slice(PREFIX.length + 1) : name
        ];
      },
      set(name: string, value: unknown) {
        store[name.startsWith(PREFIX) ? name.slice(PREFIX.length + 1) : name] =
          value;
      },
    },
    debug(msg: string) {
      debugCalls.push(String(msg));
    },
    logError() {},
    DataDirectory: { dir: "C:\\zotero-data" },
  };
  g.PathUtils = {
    join(...parts: string[]) {
      return parts.join("\\");
    },
  };
  g.IOUtils = {
    writeUTF8: async () => {},
    makeDirectory: async () => {},
    copy: async () => {},
    exists: async () => false,
    remove: async () => {},
  };
  return {
    setPref: (k, v) => {
      store[k] = v;
    },
    getPref: (k) => store[k],
    debugCalls,
  };
}
