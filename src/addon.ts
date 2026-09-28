import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
    };
    // Per-window menu registrations, so closing one window in a
    // multi-window session removes exactly that window's menu items.
    menuCleanups: Map<Window, () => void>;
    // The running pdf2zh_next process, so it can be killed on shutdown.
    currentProc: { kill(): void } | null;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      menuCleanups: new Map(),
      currentProc: null,
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
