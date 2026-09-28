import { getPref, setPref } from "../utils/prefs";

export type PresetServiceId =
  | "glm"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "siliconflow"
  | "openai"
  | "gemini"
  | "ollama"
  | "custom";

export interface ServiceProfile {
  id: string;
  name: string;
  preset: PresetServiceId;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface PresetService {
  name: string;
  baseUrl: string;
  models: string[];
}

// Every entry is an OpenAI-compatible endpoint consumed by the
// pdf2zh_next "--openai" engine (base URL + key + model).
export const PRESET_SERVICES: Record<PresetServiceId, PresetService> = {
  glm: {
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.6", "glm-4.5-air", "glm-4-flash"],
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  qwen: {
    name: "阿里云百炼 Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
  },
  kimi: {
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-0905-preview", "moonshot-v1-32k"],
  },
  siliconflow: {
    name: "SiliconFlow 硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
  },
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o"],
  },
  gemini: {
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  ollama: {
    name: "Ollama (本地)",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen3:8b"],
  },
  custom: {
    name: "自定义 OpenAI 兼容",
    baseUrl: "",
    models: [],
  },
};

export function getProfiles(): ServiceProfile[] {
  const raw = getPref("profiles");
  if (!raw || typeof raw !== "string") return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // All fields must be strings: a half-corrupted pref would otherwise
    // surface as a TypeError deep inside runTranslation instead of here.
    return list.filter(
      (p: any) =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.baseUrl === "string" &&
        typeof p.apiKey === "string" &&
        typeof p.model === "string",
    );
  } catch (e: any) {
    Zotero.logError(e);
    return [];
  }
}

export function saveProfiles(profiles: ServiceProfile[]): void {
  setPref("profiles", JSON.stringify(profiles));
}

export function getActiveProfile(): ServiceProfile | null {
  const id = String(getPref("activeProfileId") || "");
  const profiles = getProfiles();
  const found = profiles.find((p) => p.id === id);
  if (found) return found;
  if (profiles.length) {
    // Falling back silently could quietly bill a different provider's
    // key; leave a trace at least.
    Zotero.debug(
      `[fullpdf] active profile "${id}" not found; falling back to "${profiles[0].name}"`,
    );
  }
  return profiles[0] ?? null;
}

export async function testProfile(
  profile: ServiceProfile,
): Promise<{ ok: boolean; message: string }> {
  const url = `${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  try {
    const rq = await Zotero.HTTP.request("POST", url, {
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: "user", content: "Reply with: OK" }],
        max_tokens: 16,
        stream: false,
      }),
      responseType: "json",
      timeout: 30000,
    });
    const text = rq?.response?.choices?.[0]?.message?.content;
    return {
      ok: true,
      message: (typeof text === "string" && text.trim().slice(0, 60)) || "OK",
    };
  } catch (e: any) {
    const status = e?.status ?? e?.xmlHttpRequest?.status ?? "";
    const body = e?.xmlHttpRequest?.responseText ?? e?.message ?? String(e);
    return {
      ok: false,
      message: `${status} ${String(body).slice(0, 200)}`.trim(),
    };
  }
}
