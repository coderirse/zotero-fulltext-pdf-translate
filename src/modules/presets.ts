import { setPref } from "../utils/prefs";

export type TranslateMode = "fast" | "precise" | "scan" | "custom";

export interface ModePreset {
  qps: number;
  poolMaxWorkers: number;
  noAutoExtractGlossary: boolean;
  ocrWorkaround: "off" | "auto" | "on";
}

export const MODE_PRESETS: Record<
  Exclude<TranslateMode, "custom">,
  ModePreset
> = {
  fast: {
    qps: 8,
    poolMaxWorkers: 16,
    noAutoExtractGlossary: true,
    ocrWorkaround: "off",
  },
  precise: {
    qps: 2,
    poolMaxWorkers: 4,
    noAutoExtractGlossary: false,
    ocrWorkaround: "off",
  },
  scan: {
    qps: 4,
    poolMaxWorkers: 8,
    noAutoExtractGlossary: true,
    ocrWorkaround: "auto",
  },
};

// "custom" keeps whatever the user configured below.
export function applyModePreset(mode: TranslateMode): void {
  const preset = MODE_PRESETS[mode as Exclude<TranslateMode, "custom">];
  if (!preset) return;
  setPref("qps", preset.qps);
  setPref("poolMaxWorkers", preset.poolMaxWorkers);
  setPref("noAutoExtractGlossary", preset.noAutoExtractGlossary);
  setPref("ocrWorkaround", preset.ocrWorkaround);
}
