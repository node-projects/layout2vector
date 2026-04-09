import { defineConfig } from "@playwright/test";

const browser = (process.env.BROWSER as "chromium" | "firefox") || "chromium";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  retries: 0,
  use: {
    browserName: browser,
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
    // Firefox projects — use native getBoxQuads (no polyfill needed)
    {
      name: "firefox-unit",
      testMatch: "unit/**/*.test.ts",
      use: {
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "layout.css.getBoxQuads.enabled": true,
          },
        },
      },
    },
    {
      name: "firefox-integration",
      testMatch: "integration/**/*.test.ts",
      use: {
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "layout.css.getBoxQuads.enabled": true,
          },
        },
      },
    },
    {
      name: "firefox-ui",
      testMatch: "ui/**/*.test.ts",
      use: {
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "layout.css.getBoxQuads.enabled": true,
          },
        },
      },
    },
    {
      name: "firefox-demos",
      testMatch: "demos/**/*.test.ts",
      use: {
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "layout.css.getBoxQuads.enabled": true,
          },
        },
      },
    },
  ],
});
