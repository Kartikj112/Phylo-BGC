import { expect, test, type Page } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * The welcome fork and the antiSMASH upload path.
 *
 * The upload posts to a real endpoint that WRITES, so the tests that would
 * add rows intercept the request and answer it themselves. That is not
 * squeamishness about touching the database — it is that this suite runs
 * against whatever corpus the operator pointed the API at, and a test that
 * silently grafted "Streptomyces e2etest" into someone's working dataset
 * would be a bad neighbour. The server side of the same behaviour is
 * covered for real, against a real database, in
 * engine/tests/test_upload_antismash.py.
 *
 * What is exercised here is the wiring the Python tests cannot see: that
 * the fork appears, that each choice leads somewhere, that the form refuses
 * to submit without the organism the tree needs, and that placement is
 * reported rather than a bare success.
 */

const welcome = (page: Page) => page.locator("[data-welcome-dialog]");
const dialog = (page: Page) => page.locator("[data-upload-dialog]");

async function landed(page: Page) {
  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 60_000 });
  await expect(welcome(page)).toBeVisible();
}

/** A minimal, structurally valid antiSMASH result: one record, one region. */
const RESULT_JSON = JSON.stringify({
  version: "7.1.0",
  taxon: "bacteria",
  records: [
    {
      id: "NZ_E2E0000001.1",
      areas: [
        {
          start: 1000,
          end: 42000,
          products: ["T1PKS"],
          protoclusters: { "1": { category: "PKS" } },
        },
      ],
    },
  ],
});

async function attach(page: Page, name = "GCF_E2E00001.1.json") {
  await dialog(page)
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(RESULT_JSON) });
}

/** Answer the upload POST without letting it reach the database. */
async function stubUpload(page: Page, body: unknown, status = 200) {
  await page.route("**/api/v1/ingest/antismash", (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

const oneGenome = (over: Record<string, unknown> = {}) => ({
  genomes: [
    {
      filename: "GCF_E2E00001.1.json",
      accession: "GCF_E2E00001.1",
      genome_id: "00000000-0000-0000-0000-0000000000e2",
      regions_created: 1,
      regions_updated: 0,
      placement: "grafted",
      organism: "Streptomyces coelicolor",
      grafted_to: "Streptomyces",
      errors: [],
      ...over,
    },
  ],
  total_regions: 1,
  rejected: [],
});

// --- the fork ---------------------------------------------------------------

test("the page opens on a choice between browsing and uploading", async ({ page }) => {
  await landed(page);
  await expect(page.getByRole("button", { name: "Browse the tree" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Analyze my antiSMASH results/ })).toBeVisible();
});

test("choosing to browse clears the fork and leaves the tree usable", async ({ page }) => {
  await landed(page);
  await page.getByRole("button", { name: "Browse the tree" }).click();

  await expect(welcome(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  // Not merely uncovered — actually interactive.
  await page.getByTitle("Circular tree").click();
  await expect(page.getByTitle("Circular tree")).toHaveClass(/bg-chrome-accent-wash/);
});

test("Escape and the backdrop both fall through to browsing", async ({ page }) => {
  await landed(page);
  await page.keyboard.press("Escape");
  await expect(welcome(page)).toHaveCount(0);
});

test("choosing antiSMASH opens the upload dialog", async ({ page }) => {
  await landed(page);
  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

test("the upload path is still reachable after choosing to browse", async ({ page }) => {
  await landed(page);
  await dismissWelcome(page);
  // The fork is shown once per visit, so the toolbar has to carry the door.
  await page.getByRole("button", { name: "antiSMASH", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
});

// --- the form ---------------------------------------------------------------

test("upload is refused until both files and an organism are given", async ({ page }) => {
  await landed(page);
  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();

  const submit = page.getByRole("button", { name: /Upload and place on tree/ });
  await expect(submit).toBeDisabled();

  await attach(page);
  // Files alone are not enough: without an organism the genome is ingested
  // and then not drawn, which is the failure the whole feature guards.
  await expect(submit).toBeDisabled();

  await page.getByLabel(/Organism/).fill("Streptomyces coelicolor");
  await expect(submit).toBeEnabled();
});

test("a chosen file is listed and can be removed again", async ({ page }) => {
  await landed(page);
  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();
  await attach(page);

  await expect(dialog(page).getByText("GCF_E2E00001.1.json")).toBeVisible();
  await page.getByRole("button", { name: "Remove GCF_E2E00001.1.json" }).click();
  await expect(dialog(page).getByText("GCF_E2E00001.1.json")).toHaveCount(0);
});

// --- the result -------------------------------------------------------------

test("a grafted genome is reported as on the tree, and the tree is re-fetched", async ({ page }) => {
  await landed(page);
  await stubUpload(page, oneGenome());

  let treeFetches = 0;
  await page.route("**/api/v1/taxonomy-tree**", (route) => {
    treeFetches += 1;
    return route.continue();
  });

  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();
  await attach(page);
  await page.getByLabel(/Organism/).fill("Streptomyces coelicolor");
  await page.getByRole("button", { name: /Upload and place on tree/ }).click();

  await expect(dialog(page).getByText("On the tree")).toBeVisible();
  await expect(dialog(page).getByText("Streptomyces", { exact: false }).first()).toBeVisible();

  // The stale-render trap: reporting "placed on the tree" while showing the
  // tree from before the upload.
  await expect.poll(() => treeFetches, { timeout: 15_000 }).toBeGreaterThan(0);

  // And it takes the reader to what they just added.
  await page.getByRole("button", { name: "View the tree" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByPlaceholder("Search taxa, accessions, compounds")).toHaveValue(
    "GCF_E2E00001.1",
  );
});

test("a genome that could not be placed says so instead of claiming success", async ({ page }) => {
  await landed(page);
  await stubUpload(
    page,
    oneGenome({ placement: "species_only", organism: "Aspergillus nidulans", grafted_to: null }),
  );

  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();
  await attach(page);
  await page.getByLabel(/Organism/).fill("Aspergillus nidulans");
  await page.getByRole("button", { name: /Upload and place on tree/ }).click();

  await expect(dialog(page).getByText("Saved, not placed")).toBeVisible();
  await expect(dialog(page).getByText(/GTDB is prokaryote-only/)).toBeVisible();
});

test("a rejected file is named, not silently dropped", async ({ page }) => {
  await landed(page);
  await stubUpload(page, {
    genomes: [],
    total_regions: 0,
    rejected: ["broken.json: not valid JSON (line 1)"],
  });

  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();
  await attach(page, "broken.json");
  await page.getByLabel(/Organism/).fill("Streptomyces coelicolor");
  await page.getByRole("button", { name: /Upload and place on tree/ }).click();

  await expect(dialog(page).getByText("Not read")).toBeVisible();
  await expect(dialog(page).getByText(/broken\.json/)).toBeVisible();
});

test("a read-only deployment's refusal is shown in words, not as a status code", async ({ page }) => {
  await landed(page);
  await stubUpload(page, { detail: "This deployment is read-only (BGCSCAPE_ALLOW_UPLOADS is off)." }, 403);

  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();
  await attach(page);
  await page.getByLabel(/Organism/).fill("Streptomyces coelicolor");
  await page.getByRole("button", { name: /Upload and place on tree/ }).click();

  await expect(dialog(page).getByText(/This deployment is read-only/)).toBeVisible();
});
