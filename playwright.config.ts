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
      name: "demos",
      testMatch: "demos/**/*.test.ts",
      /*use: {
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "layout.css.getBoxQuads.enabled": true,
          },
        },
      },*/
    },
  ],
});
