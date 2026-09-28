// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      // Node CLI scripts (repo tooling), not plugin code
      files: ["scripts/**/*.mjs"],
      languageOptions: {
        globals: {
          console: "readonly",
          process: "readonly",
        },
      },
    },
  ],
});
