import {
  bindings,
  defineConfig,
  exports,
} from "cf/config";

export default defineConfig({
  worker: {
    name: "oriel-relay",
    entrypoint: "./build/index.js",
    compatibilityDate: "2026-10-05",

    exports: {
      RelayDevice: exports.durableObject({
        storage: "sqlite",
      }),
    },

    env: {
      RELAY: bindings.durableObject({
        worker: "oriel-relay",
        exportName: "RelayDevice",
      }),
    },
  },
});
