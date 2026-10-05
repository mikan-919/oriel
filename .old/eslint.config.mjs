import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // 依存配列の取りこぼしはintervalの再生成など実挙動へ出るので、警告では
      // なくlintの失敗として扱う。
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
