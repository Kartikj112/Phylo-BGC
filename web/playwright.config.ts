import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level end-to-end tests.
 *
 * These exist because a whole class of this project's real bugs lived
 * exactly where unit tests could not see them — the CORS preflight that
 * `TestClient` never issues, the export button's `URL.createObjectURL` +
 * synthetic-click path, the tree's middle-drag pan. A stress test of the
 * shipped build could verify the HTTP leg and the pure functions, and had
 * to report every interaction above them as unverified.
 *
 * Run with `npm run e2e`. Both servers must already be running — the API on
 * PLAYWRIGHT_API_URL and the frontend on PLAYWRIGHT_BASE_URL — because the
 * API needs a real database chosen by the operator, not a fixture this
 * config could invent.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3311",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A real viewport: the tree's semantic zoom and label-fitting depend on
    // it, so a headless default of 800x600 would exercise a layout no user
    // sees.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // The desktop specs assert the desktop layout — a pinned left rail, a
      // side detail column, shift-click and double-click. Running them under
      // the phone project would assert a layout that deliberately does not
      // exist there.
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      // The touch build is a different interaction model, not a narrower
      // one: pinch instead of wheel, an action menu instead of modifier
      // clicks, a bottom sheet instead of a column. `hasTouch` is what makes
      // `(pointer: coarse)` match, which is what the canvas branches on.
      name: "mobile",
      // Chromium, not the device's default WebKit: the pinch assertions
      // dispatch raw multi-touch through CDP, which is Chromium-only. The
      // device profile still supplies what matters here — the 390px
      // viewport, the touch flags, and the mobile user agent.
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
});
