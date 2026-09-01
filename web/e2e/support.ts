import type { Page } from "@playwright/test";

/**
 * Get past the welcome fork to the tree.
 *
 * Every spec that drives the tree needs this now: the page opens on a
 * choice ("browse" or "upload antiSMASH results"), and a test that goes
 * straight to clicking a clade would be clicking through a modal backdrop.
 *
 * Tolerant of the dialog being absent, so it is safe to call from a spec
 * that has already dismissed it, or one that loaded with an API failure
 * where the gate never appears.
 */
export async function dismissWelcome(page: Page): Promise<void> {
  const browse = page.getByRole("button", { name: "Browse the tree" });
  try {
    await browse.waitFor({ state: "visible", timeout: 15_000 });
    await browse.click();
    await page.locator("[data-welcome-dialog]").waitFor({ state: "detached", timeout: 5_000 });
  } catch {
    /* No gate on screen — nothing to dismiss. */
  }
}
