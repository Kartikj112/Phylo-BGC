import { expect, test, type Page } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * The landing splash (LoadingOverlay).
 *
 * The property that matters is not that it appears — it is that it always
 * LEAVES, and that it never leaves before there is something behind it. A
 * cover that outlives its load is worse than no cover: the app looks hung,
 * and on the failure path it hides the very error explaining why.
 *
 * So every test here is about the exit, and two of them deliberately break
 * something (the API, the video) to check the exit still happens.
 */

const overlay = (page: Page) => page.locator("[data-loading-overlay]");

/** Hold the tree back so the splash can be observed at full opacity — the
 * cold-API case it exists for. Render's free tier cold-starts in 30-60s. */
async function slowTree(page: Page, ms = 5000) {
  await page.route("**/api/v1/taxonomy-tree**", async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

test("covers the landing, then leaves on its own with the tree behind it", async ({ page }) => {
  await slowTree(page);
  await page.goto("/");

  await expect(overlay(page)).toHaveAttribute("data-loading-overlay", "visible");
  // Opaque while it is up: a half-transparent splash over a blank stage
  // reads as a rendering fault rather than as loading.
  await expect(overlay(page)).toHaveCSS("opacity", "1");

  await overlay(page).waitFor({ state: "detached", timeout: 60_000 });
  await expect(page.locator("svg [data-figure-root='true'] g[data-node-key]").first()).toBeVisible();
});

test("does not swallow the first click once it starts fading", async ({ page }) => {
  await page.goto("/");
  await overlay(page).waitFor({ state: "detached", timeout: 60_000 });
  // The welcome fork sits where the splash was, dead centre. If the fading
  // cover were still hit-testable, this click would land on it and time out
  // rather than take effect.
  await page.getByRole("button", { name: "Browse the tree" }).click();
  await expect(page.locator("[data-welcome-dialog]")).toHaveCount(0);
  await page.getByTitle("Circular tree").click();
  await expect(page.getByTitle("Circular tree")).toHaveClass(/bg-chrome-accent-wash/);
});

test("stays gone when a later load reloads the tree", async ({ page }) => {
  await page.goto("/");
  await overlay(page).waitFor({ state: "detached", timeout: 60_000 });
  await dismissWelcome(page);

  // Switching taxonomy re-fetches a whole tree. Covering the screen for that
  // would hide the exact change the click asked for.
  await page.getByRole("button", { name: "Eukaryotes" }).click();
  await page.waitForTimeout(1500);
  await expect(overlay(page)).toHaveCount(0);
});

test("leaves and uncovers the error when the tree cannot be fetched", async ({ page }) => {
  await page.route("**/api/v1/taxonomy-tree**", (route) => route.abort());
  await page.goto("/");

  await overlay(page).waitFor({ state: "detached", timeout: 30_000 });
  await expect(page.getByText("Couldn't reach the API", { exact: false })).toBeVisible();
});

test("falls back to the still logo when the video is missing", async ({ page }) => {
  await page.route("**/logo-animation.mp4", (route) => route.fulfill({ status: 404, body: "" }));
  await slowTree(page);
  await page.goto("/");

  // The positive assertion first, deliberately. `toHaveCount(0)` on the
  // video is also satisfied by an overlay that has already detached, so on
  // its own it would pass for the wrong reason — which is exactly how the
  // pre-hydration `onError` gap first hid behind a green test.
  await expect(overlay(page).getByAltText("Phylo-BGC")).toBeVisible();
  await expect(overlay(page).locator("video")).toHaveCount(0);
  await overlay(page).waitFor({ state: "detached", timeout: 60_000 });
});

test("shows the still logo, not the animation, under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await slowTree(page);
  await page.goto("/");

  await expect(overlay(page).getByAltText("Phylo-BGC")).toBeVisible();
  await expect(overlay(page).locator("video")).toHaveCount(0);
});
