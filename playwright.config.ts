import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  retries: 0,
  use: {
    browserName: "chromium",
    headless: true,
  },
  projects: [
    {
      name: "unit",
      testMatch: "unit/**/*.test.ts",
    },
    {
      name: "integration",
      testMatch: "integration/**/*.test.ts",
    },
    {
      name: "ui",
      testMatch: "ui/**/*.test.ts",
    },
    {
      name: "demos",
      testMatch: "demos/**/*.test.ts",
    },
  ],
});
