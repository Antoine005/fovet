import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [".claude/**", "node_modules/**"],
    env: {
      JWT_SECRET: "vitest-secret-32-chars-long-enough",
      DASHBOARD_PASSWORD: "test-password",
      ALLOWED_ORIGIN: "http://localhost:3000,https://watch.ardent.io",
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
