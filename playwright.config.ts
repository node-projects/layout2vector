import { defineConfig } from "@playwright/test";

const chromeCanary = {
  browserName: "chromium" as const,
  channel: "chrome-canary",
  launchOptions: {
    args: ["--enable-experimental-web-platform-features"],
  },
};

const firefox = {
  browserName: "firefox" as const,
  launchOptions: {
    firefoxUserPrefs: {
      "layout.css.getBoxQuads.enabled": true,
    },
  },
};

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
  },
  projects: [
    {
      name: "unit",
      testMatch: "unit/**/*.test.ts",
      use: chromeCanary,
    },
    {
      name: "integration",
      testMatch: "integration/**/*.test.ts",
      use: chromeCanary,
    },
    {
      name: "ui",
      testMatch: "ui/**/*.test.ts",
      use: chromeCanary,
    },
    {
      name: "demos",
      testMatch: "demos/**/*.test.ts",
      use: chromeCanary,
    },
    // Firefox projects — use native getBoxQuads (no polyfill needed)
    {
      name: "firefox-unit",
      testMatch: "unit/**/*.test.ts",
      use: firefox,
    },
    {
      name: "firefox-integration",
      testMatch: "integration/**/*.test.ts",
      use: firefox,
    },
    {
      name: "firefox-ui",
      testMatch: "ui/**/*.test.ts",
      use: firefox,
    },
    {
      name: "firefox-demos",
      testMatch: "demos/**/*.test.ts",
      use: firefox,
    },
  ],
});
