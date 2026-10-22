import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:4318", channel: "chrome" },
  webServer: {
    command: "npx vite build && npx vite preview --port 4318 --strictPort --host 127.0.0.1",
    cwd: ".",
    url: "http://127.0.0.1:4318",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
