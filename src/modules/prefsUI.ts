import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  browseForEngine,
  browseForGlossary,
  detectEngine,
  downloadEngine,
} from "./engine";
import {
  PRESET_SERVICES,
  getProfiles,
  saveProfiles,
  testProfile,
  type PresetServiceId,
  type ServiceProfile,
} from "./profiles";
import { applyModePreset, type TranslateMode } from "./presets";

let lastWindow: Window | null = null;
let editingProfileId: string | null = null;

function $(win: Window, id: string): any {
  return win.document.getElementById(`${config.addonRef}-${id}`);
}

function valueOf(win: Window, id: string): string {
  const el = $(win, id);
  return el ? String(el.value ?? "") : "";
}

function setValue(
  win: Window,
  id: string,
  value: string | number | boolean,
): void {
  const el = $(win, id);
  if (!el) return;
  if (typeof value === "boolean") {
    if (typeof el.checked === "boolean") el.checked = value;
    else el.value = String(value);
  } else {
    el.value = String(value);
  }
}

function setLabel(win: Window, id: string, text: string, color?: string): void {
  const el = $(win, id);
  if (!el) return;
  el.setAttribute("value", text);
  el.setAttribute("style", color ? `color: ${color}` : "");
}

export async function registerPrefsScripts(window: Window): Promise<void> {
  if (lastWindow !== window) {
    initProfileUI(window);
    initModeUI(window);
    initParamUI(window);
    initEngineUI(window);
    lastWindow = window;
  }
  syncAllFromPrefs(window);
}

function syncAllFromPrefs(win: Window): void {
  syncParamInputs(win);
  renderProfileList(win);
  void refreshEngineStatus(win);
}

/* ---------------- profiles ---------------- */

function initProfileUI(win: Window): void {
  const presetMenu = $(win, "profile-preset");
  const presetPopup = presetMenu?.querySelector("menupopup");
  if (presetPopup && !presetPopup.childElementCount) {
    for (const [id, svc] of Object.entries(PRESET_SERVICES)) {
      const mi = win.document.createXULElement("menuitem");
      mi.setAttribute("value", id);
      mi.setAttribute("label", svc.name);
      presetPopup.appendChild(mi);
    }
  }
  presetMenu?.addEventListener("command", () => {
    const id = String(presetMenu.value || "") as PresetServiceId;
    const svc = PRESET_SERVICES[id];
    if (!svc) return;
    setValue(win, "profile-baseurl", svc.baseUrl);
    if (svc.models.length) setValue(win, "profile-model", svc.models[0]);
  });

  $(win, "profile-list")?.addEventListener("select", () =>
    loadSelectedProfileIntoEditor(win),
  );
  $(win, "profile-new")?.addEventListener("command", () => {
    editingProfileId = null;
    setValue(win, "profile-name", "");
    setValue(win, "profile-preset", "glm");
    setValue(win, "profile-baseurl", PRESET_SERVICES.glm.baseUrl);
    setValue(win, "profile-key", "");
    setValue(win, "profile-model", PRESET_SERVICES.glm.models[0]);
    setLabel(win, "profile-test-result", "");
    $(win, "profile-name")?.focus?.();
  });
  $(win, "profile-save")?.addEventListener("command", () =>
    saveProfileFromEditor(win),
  );
  $(win, "profile-delete")?.addEventListener("command", () =>
    deleteSelectedProfile(win),
  );
  $(win, "profile-test")?.addEventListener(
    "command",
    () => void testProfileFromEditor(win),
  );
  $(win, "active-profile")?.addEventListener("command", () => {
    const ml = $(win, "active-profile");
    if (ml?.value) setPref("activeProfileId", String(ml.value));
    renderProfileList(win);
  });
}

function renderProfileList(win: Window): void {
  const list = $(win, "profile-list");
  if (!list) return;
  list.textContent = "";
  const activeId = String(getPref("activeProfileId") || "");
  const profiles = getProfiles();
  for (const p of profiles) {
    const item = win.document.createXULElement("richlistitem");
    item.setAttribute("value", p.id);
    const vbox = win.document.createXULElement("vbox");
    const l1 = win.document.createXULElement("label");
    l1.setAttribute("value", `${p.id === activeId ? "● " : ""}${p.name}`);
    const l2 = win.document.createXULElement("label");
    l2.setAttribute("class", "fullpdf-secondary");
    const svcName = PRESET_SERVICES[p.preset]?.name ?? p.preset;
    l2.setAttribute("value", `${svcName} · ${p.model}`);
    vbox.appendChild(l1);
    vbox.appendChild(l2);
    item.appendChild(vbox);
    list.appendChild(item);
  }
  renderActiveProfileMenu(win);
}

function renderActiveProfileMenu(win: Window): void {
  const ml = $(win, "active-profile");
  if (!ml) return;
  ml.textContent = "";
  const popup = win.document.createXULElement("menupopup");
  for (const p of getProfiles()) {
    const mi = win.document.createXULElement("menuitem");
    mi.setAttribute("value", p.id);
    mi.setAttribute("label", p.name);
    popup.appendChild(mi);
  }
  ml.appendChild(popup);
  const activeId = String(getPref("activeProfileId") || "");
  const profiles = getProfiles();
  if (activeId && profiles.some((p) => p.id === activeId)) {
    ml.value = activeId;
  } else if (profiles.length) {
    ml.value = profiles[0].id;
    setPref("activeProfileId", profiles[0].id);
  }
}

function loadSelectedProfileIntoEditor(win: Window): void {
  const list = $(win, "profile-list");
  const id = list?.selectedItem?.getAttribute?.("value");
  if (!id) return;
  const p = getProfiles().find((x) => x.id === id);
  if (!p) return;
  editingProfileId = p.id;
  setValue(win, "profile-name", p.name);
  setValue(win, "profile-preset", p.preset);
  setValue(win, "profile-baseurl", p.baseUrl);
  setValue(win, "profile-key", p.apiKey);
  setValue(win, "profile-model", p.model);
}

function saveProfileFromEditor(win: Window): void {
  const name = valueOf(win, "profile-name").trim();
  const preset = (valueOf(win, "profile-preset") ||
    "custom") as PresetServiceId;
  const baseUrl = valueOf(win, "profile-baseurl").trim();
  const apiKey = valueOf(win, "profile-key").trim();
  const model = valueOf(win, "profile-model").trim();
  if (!name || !baseUrl || !model) {
    win.alert(getString("pref-profile-incomplete"));
    return;
  }
  const profiles = getProfiles();
  if (editingProfileId) {
    const p = profiles.find((x) => x.id === editingProfileId);
    if (p) Object.assign(p, { name, preset, baseUrl, apiKey, model });
  } else {
    const id = Zotero.Utilities.generateObjectKey();
    profiles.push({ id, name, preset, baseUrl, apiKey, model });
    editingProfileId = id;
    if (!String(getPref("activeProfileId") || "")) {
      setPref("activeProfileId", id);
    }
  }
  saveProfiles(profiles);
  renderProfileList(win);
  const list = $(win, "profile-list");
  const idx = profiles.findIndex((p) => p.id === editingProfileId);
  if (list && idx >= 0) list.selectedIndex = idx;
}

function deleteSelectedProfile(win: Window): void {
  const list = $(win, "profile-list");
  const id = list?.selectedItem?.getAttribute?.("value");
  if (!id) return;
  const confirmed = win.confirm(getString("pref-profile-delete-confirm"));
  if (!confirmed) return;
  saveProfiles(getProfiles().filter((p) => p.id !== id));
  if (String(getPref("activeProfileId") || "") === id) {
    setPref("activeProfileId", "");
  }
  editingProfileId = null;
  setValue(win, "profile-name", "");
  setValue(win, "profile-baseurl", "");
  setValue(win, "profile-key", "");
  setValue(win, "profile-model", "");
  renderProfileList(win);
}

async function testProfileFromEditor(win: Window): Promise<void> {
  const profile: ServiceProfile = {
    id: editingProfileId ?? "temp",
    name: valueOf(win, "profile-name").trim() || "test",
    preset: (valueOf(win, "profile-preset") || "custom") as PresetServiceId,
    baseUrl: valueOf(win, "profile-baseurl").trim(),
    apiKey: valueOf(win, "profile-key").trim(),
    model: valueOf(win, "profile-model").trim(),
  };
  setLabel(win, "profile-test-result", getString("pref-testing"), "gray");
  const res = await testProfile(profile);
  if (res.ok) {
    setLabel(
      win,
      "profile-test-result",
      `✓ ${getString("pref-test-ok")} (${res.message})`,
      "green",
    );
  } else {
    setLabel(
      win,
      "profile-test-result",
      `✗ ${getString("pref-test-fail")}: ${res.message}`,
      "red",
    );
  }
}

/* ---------------- mode & params ---------------- */

function initModeUI(win: Window): void {
  const rg = $(win, "mode");
  rg?.addEventListener("command", () => {
    const mode = String(rg.value || "fast") as TranslateMode;
    setPref("mode", mode);
    applyModePreset(mode);
    syncParamInputs(win);
  });
}

function bindChange(
  win: Window,
  id: string,
  apply: (value: string) => void,
): void {
  const el = $(win, id);
  if (!el) return;
  const handler = () => apply(String(el.value ?? ""));
  el.addEventListener("change", handler);
  // menulist selections fire "command"
  el.addEventListener("command", handler);
}

function bindCheck(
  win: Window,
  id: string,
  apply: (checked: boolean) => void,
): void {
  const el = $(win, id);
  el?.addEventListener("command", () => apply(el.checked === true));
}

function initParamUI(win: Window): void {
  bindChange(win, "lang-in", (v) => setPref("langIn", v.trim() || "en"));
  bindChange(win, "lang-out", (v) => setPref("langOut", v.trim() || "zh"));
  bindChange(win, "output", (v) => setPref("output", v || "dual"));
  bindChange(win, "qps", (v) =>
    setPref("qps", Math.max(1, Math.floor(Number(v) || 4))),
  );
  bindChange(win, "pool", (v) =>
    setPref("poolMaxWorkers", Math.max(1, Math.floor(Number(v) || 4))),
  );
  bindChange(win, "pages", (v) => setPref("pages", v.trim()));
  bindChange(win, "ocr", (v) => setPref("ocrWorkaround", v || "off"));
  bindChange(win, "prompt", (v) => setPref("customSystemPrompt", v));
  bindChange(win, "glossary", (v) => setPref("glossaryFile", v.trim()));
  bindCheck(win, "no-glossary", (c) => setPref("noAutoExtractGlossary", c));
  bindCheck(win, "watermark", (c) => setPref("watermark", c));
  bindCheck(win, "autoopen", (c) => setPref("autoOpen", c));
  $(win, "glossary-browse")?.addEventListener(
    "command",
    () =>
      void browseForGlossary(win).then((path) => {
        if (path) {
          setValue(win, "glossary", path);
          setPref("glossaryFile", path);
        }
      }),
  );
}

function syncParamInputs(win: Window): void {
  setValue(win, "lang-in", String(getPref("langIn") || "en"));
  setValue(win, "lang-out", String(getPref("langOut") || "zh"));
  setValue(win, "output", String(getPref("output") || "dual"));
  setValue(win, "qps", Number(getPref("qps")) || 4);
  setValue(win, "pool", Number(getPref("poolMaxWorkers")) || 4);
  setValue(win, "pages", String(getPref("pages") || ""));
  setValue(win, "ocr", String(getPref("ocrWorkaround") || "off"));
  setValue(win, "prompt", String(getPref("customSystemPrompt") || ""));
  setValue(win, "glossary", String(getPref("glossaryFile") || ""));
  setValue(win, "no-glossary", getPref("noAutoExtractGlossary") === true);
  setValue(win, "watermark", getPref("watermark") === true);
  setValue(win, "autoopen", getPref("autoOpen") === true);
  const rg = $(win, "mode");
  if (rg) rg.value = String(getPref("mode") || "fast");
}

/* ---------------- engine ---------------- */

function initEngineUI(win: Window): void {
  $(win, "engine-download")?.addEventListener(
    "command",
    () => void downloadEngineUI(win),
  );
  $(win, "engine-browse")?.addEventListener(
    "command",
    () => void browseEngineUI(win),
  );
  $(win, "engine-reset")?.addEventListener("command", () => {
    setPref("enginePath", "");
    void refreshEngineStatus(win);
  });
  bindChange(win, "download-prefix", (v) =>
    setPref("downloadURLPrefix", v.trim()),
  );
}

async function refreshEngineStatus(win: Window): Promise<void> {
  const found = await detectEngine();
  setLabel(
    win,
    "engine-status",
    found
      ? `${getString("pref-engine-ready")} [${found.kind === "next" ? "pdf2zh_next" : "pdf2zh v1"}]: ${found.path}`
      : getString("pref-engine-missing"),
  );
}

async function downloadEngineUI(win: Window): Promise<void> {
  const btn = $(win, "engine-download");
  btn?.setAttribute("disabled", "true");
  try {
    const engine = await downloadEngine((pct, message) =>
      setLabel(
        win,
        "engine-status",
        pct == null ? message : `${message} ${pct}%`,
      ),
    );
    setLabel(
      win,
      "engine-status",
      `${getString("pref-engine-ready")} [${engine.kind === "next" ? "pdf2zh_next" : "pdf2zh v1"}]: ${engine.path}`,
      "green",
    );
  } catch (e: any) {
    setLabel(
      win,
      "engine-status",
      `${getString("engine-download-failed")}: ${String(e?.message ?? e).slice(0, 200)}`,
      "red",
    );
  } finally {
    btn?.removeAttribute("disabled");
  }
}

async function browseEngineUI(win: Window): Promise<void> {
  const path = await browseForEngine(win);
  if (path) {
    setPref("enginePath", path);
    await refreshEngineStatus(win);
  }
}
