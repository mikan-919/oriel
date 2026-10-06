import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  assetsDirectory: "./build",
  dev: {
    port: 3001,
  },
  types: {
    generate: false,
  },
});
