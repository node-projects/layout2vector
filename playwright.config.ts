import { defineConfig } from "@playwright/test";

const chromeCanary = {
  browserName: "chromium" as const,
  // Canary is a local development option; CI installs Playwright's Chromium.
  channel: process.env.CI ? undefined : "chrome-canary",
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
  timeout: 60000,
  retries: 0,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,
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
      testIgnore: "**/screenshot.test.ts",
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
      testIgnore: "**/screenshot.test.ts",
      use: firefox,
    },
    {
      name: "previews",
      testMatch: "demos/screenshot.test.ts",
      dependencies: ["demos", "firefox-demos"],
      use: chromeCanary,
    },
  ],
});
