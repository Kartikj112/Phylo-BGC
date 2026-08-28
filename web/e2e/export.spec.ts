import { expect, test } from "@playwright/test";

/**
 * The export button's BROWSER path.
 *
 * `URL.createObjectURL` + a synthetic `link.click()` was exercised only
 * through unit tests of the pure functions around it — PROGRESS.md flagged
 * it as untested, and a full stress test could still only verify the HTTP
 * leg. A CORS preflight regression once broke exactly this path while 24
 * server-side API tests passed, because `TestClient` never issues OPTIONS.
 *
 * These tests drive the real button and intercept the real download.
 */

test("SVG export downloads a self-describing figure from the browser", async ({ page }) => {
  // The export flow asks for a title with window.prompt(), which blocks the
  // page until handled.
  page.on("dialog", (d) => d.accept("E2E export"));

  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 45_000 });

  const svgButton = page.getByRole("button", { name: "svg", exact: true });
  await expect(svgButton).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 45_000 }),
    svgButton.click(),
  ]);

  const name = download.suggestedFilename();
  expect(name).toMatch(/\.svg$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");

  // The figure must carry its own provenance — the whole point of the
  // export format. `bgcscape inspect-figure` reads exactly this block.
  expect(text).toContain("<svg");
  expect(text).toContain("bgcscape-view-config");
  expect(text).toContain("Sources:");
  expect(text).toContain("BGC-scape");
});

test("PDF export either downloads or reports a usable error, never a bare 500", async ({ page }) => {
  page.on("dialog", (d) => d.accept("E2E export"));
  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 45_000 });

  const pdfButton = page.getByRole("button", { name: "pdf", exact: true });
  await expect(pdfButton).toBeVisible();

  const downloadPromise = page
    .waitForEvent("download", { timeout: 20_000 })
    .catch(() => null);
  await pdfButton.click();
  const download = await downloadPromise;

  if (download) {
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    return;
  }

  // No PDF: the server lacks the Cairo system library. That is a legitimate
  // deployment state, but the user must be told something actionable —
  // "Export failed: 500" (what this used to show) is not.
  const error = page.locator("text=/Export failed|Cairo|PDF export/i").first();
  await expect(error).toBeVisible({ timeout: 15_000 });
  const message = (await error.textContent()) ?? "";
  expect(message, `unhelpful export error: ${message}`).not.toMatch(/^Export failed: 5\d\d$/);
  expect(message.toLowerCase()).toMatch(/cairo|svg export|install/);
});

test("the export POST survives a real CORS preflight", async ({ page }) => {
  // The frontend and API are on different origins in this setup, so the
  // browser issues a genuine OPTIONS preflight before the export POST.
  // A regression here is invisible to every server-side test.
  const preflights: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "OPTIONS") preflights.push(r.url());
  });
  const failures: string[] = [];
  page.on("requestfailed", (r) => failures.push(`${r.method()} ${r.url()}`));

  page.on("dialog", (d) => d.accept(""));
  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 45_000 });

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/export"), { timeout: 45_000 }),
    page.getByRole("button", { name: "svg", exact: true }).click(),
  ]);

  expect(response.status(), "export POST must not be blocked by CORS").toBe(200);
  expect(failures.filter((f) => f.includes("/api/v1/export"))).toEqual([]);
});
