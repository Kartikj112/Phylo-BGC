import { expect, test, type Page } from "@playwright/test";

/**
 * The two highlights an upload leaves on the tree.
 *
 * Nothing here writes to the database. The upload POST is answered by a
 * stub, and the tree fetch is intercepted and the REAL payload mutated to
 * contain the genome that stub claims to have added — so the whole frontend
 * path is exercised (lineage walk, family union, forced expansion, framing,
 * stroke colours) against a real corpus, without grafting "Streptomyces
 * e2etest" into whatever dataset the operator pointed the API at.
 *
 * The server side of the same feature is covered against a real database in
 * engine/tests/test_upload_antismash.py.
 */

const ACCESSION = "GCF_E2EHILITE.1";
const FAMILY = "e2e-family-0001";
const LINEAGE_STROKE = "#7B1E2B"; // COLORS.signal
const SHARED_STROKE = "#2C5F52"; // COLORS.present

const dialog = (page: Page) => page.locator("[data-upload-dialog]");
const legend = (page: Page) => page.getByText("Your upload", { exact: true });

type Node = {
  name: string;
  children: Node[];
  direct_genomes: { accession: string; bgcs: { family_ids: string[] }[] }[];
};

/**
 * Answer the tree fetch with the real corpus plus one planted genome.
 *
 * `plantShared` also stamps the same family onto a genome in a DIFFERENT
 * subtree, which is what gives the shared-family highlight somewhere to go.
 */
async function stubTree(page: Page, { plantShared }: { plantShared: boolean }) {
  await page.route("**/api/v1/taxonomy-tree**", async (route) => {
    const response = await route.fetch();
    const tree = (await response.json()) as Node;

    // Deepest-first, so the planted genome hangs off a real species rather
    // than a phylum — the lineage under test has to be a full-length one.
    const leaves: Node[] = [];
    const walk = (n: Node) => {
      if (n.children.length === 0) leaves.push(n);
      n.children.forEach(walk);
    };
    walk(tree);
    if (leaves.length < 2) throw new Error("corpus too small to plant into");

    leaves[0]!.direct_genomes.push({
      accession: ACCESSION,
      bgcs: [{ family_ids: [FAMILY] }],
    } as Node["direct_genomes"][number]);

    if (plantShared) {
      // The far end of the tree, so the shared branch cannot be confused
      // with a segment of the upload's own lineage.
      const other = leaves[leaves.length - 1]!;
      other.direct_genomes.push({
        accession: "GCF_E2ERELATIVE.1",
        bgcs: [{ family_ids: [FAMILY] }],
      } as Node["direct_genomes"][number]);
    }

    await route.fulfill({ json: tree });
  });
}

async function stubUpload(page: Page, familyIds: string[]) {
  await page.route("**/api/v1/ingest/antismash", (route) =>
    route.fulfill({
      json: {
        genomes: [
          {
            filename: `${ACCESSION}.json`,
            accession: ACCESSION,
            genome_id: "00000000-0000-0000-0000-00000000e2e1",
            regions_created: 1,
            regions_updated: 0,
            placement: "grafted",
            organism: "Streptomyces e2etest",
            grafted_to: "Streptomyces",
            errors: [],
          },
        ],
        total_regions: 1,
        rejected: [],
        clustering: familyIds.length
          ? {
              filename: "mix_clustering_c0.3.tsv",
              cutoff: 0.3,
              memberships_created: 2,
              memberships_updated: 0,
              unmatched_rows: 0,
              family_ids: familyIds,
              errors: [],
            }
          : null,
      },
    }),
  );
}

async function upload(page: Page, { families }: { families: string[] }) {
  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 60_000 });
  await page.getByRole("button", { name: /Analyze my antiSMASH results/ }).click();
  await dialog(page)
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: `${ACCESSION}.json`,
      mimeType: "application/json",
      buffer: Buffer.from('{"version":"7.1.0","records":[]}'),
    });
  await page.getByLabel(/Organism/).fill("Streptomyces e2etest");
  await page.getByRole("button", { name: /Upload and place on tree/ }).click();
  await expect(dialog(page).getByText("On the tree")).toBeVisible();
  await page.getByRole("button", { name: "View the tree" }).click();
  await page.waitForTimeout(4000);
}

/** Branch strokes by colour, read off the DOM the canvas actually wrote. */
function strokes(page: Page) {
  return page.evaluate(() => {
    const paths = Array.from(document.querySelectorAll("svg [data-figure-root='true'] path"));
    const byColour = (c: string) => paths.filter((p) => p.getAttribute("stroke") === c).length;
    return {
      lineage: byColour("#7B1E2B"),
      shared: byColour("#2C5F52"),
      rings: document.querySelectorAll(
        'svg [data-figure-root="true"] circle[stroke="#7B1E2B"]',
      ).length,
    };
  });
}

test("the lineage to the new genome is drawn from the root, and its tip is ringed", async ({
  page,
}) => {
  await stubTree(page, { plantShared: false });
  await stubUpload(page, []);
  await upload(page, { families: [] });

  const drawn = await strokes(page);
  // A full lineage, not a stub: root -> domain -> phylum -> ... -> genome is
  // several segments deep in any real corpus. One or two would mean the path
  // stopped at the collapse level instead of being forced open.
  expect(drawn.lineage, "the lineage should be several branches deep").toBeGreaterThan(3);
  expect(drawn.rings, "the uploaded tip should be ringed").toBeGreaterThan(0);
});

test("without a clustering file nothing is marked as sharing a cluster", async ({ page }) => {
  await stubTree(page, { plantShared: true });
  await stubUpload(page, []);
  await upload(page, { families: [] });

  // The corpus genuinely contains a genome in the same family here, and it
  // still must not be highlighted: no clustering file was supplied, so the
  // app has no basis for the claim.
  expect((await strokes(page)).shared).toBe(0);
  await expect(
    page.getByText(/Add a BiG-SCAPE clustering file/),
  ).toBeVisible();
});

test("with a clustering file, branches sharing a family are highlighted too", async ({ page }) => {
  await stubTree(page, { plantShared: true });
  await stubUpload(page, [FAMILY]);
  await upload(page, { families: [FAMILY] });

  const drawn = await strokes(page);
  expect(drawn.lineage).toBeGreaterThan(3);
  expect(drawn.shared, "a branch elsewhere carries the same family").toBeGreaterThan(0);
  await expect(page.getByText(/shares a BiG-SCAPE family/)).toBeVisible();
});

test("the legend says what the colours mean and can be dismissed", async ({ page }) => {
  await stubTree(page, { plantShared: true });
  await stubUpload(page, [FAMILY]);
  await upload(page, { families: [FAMILY] });

  await expect(legend(page)).toBeVisible();
  await expect(page.getByText(/lineage to 1 uploaded genome/)).toBeVisible();

  await page.getByRole("button", { name: "Clear the upload highlight" }).click();
  await page.waitForTimeout(1500);
  await expect(legend(page)).toHaveCount(0);

  // And the tree goes back to its ordinary colouring rather than keeping a
  // highlight nothing explains any more.
  const drawn = await strokes(page);
  expect(drawn.lineage).toBe(0);
  expect(drawn.shared).toBe(0);
});

test("a class filter left on from browsing does not fade the highlight away", async ({ page }) => {
  await stubTree(page, { plantShared: true });
  await stubUpload(page, [FAMILY]);

  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 60_000 });
  await page.getByRole("button", { name: "Browse the tree" }).click();

  // Narrow to one class first — the planted genome's cluster has none, so
  // without the exemption it would be dimmed to 0.15 opacity.
  await page.getByRole("button", { name: "Terpene", exact: false }).first().click();
  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: "Upload antiSMASH results" }).click();
  await dialog(page)
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: `${ACCESSION}.json`,
      mimeType: "application/json",
      buffer: Buffer.from('{"version":"7.1.0","records":[]}'),
    });
  await page.getByLabel(/Organism/).fill("Streptomyces e2etest");
  await page.getByRole("button", { name: /Upload and place on tree/ }).click();
  await expect(dialog(page).getByText("On the tree")).toBeVisible();
  await page.getByRole("button", { name: "View the tree" }).click();
  await page.waitForTimeout(4000);

  expect((await strokes(page)).lineage).toBeGreaterThan(3);
  const faded = await page.evaluate(() => {
    const g = document.querySelector('svg [data-figure-root="true"] g[data-node-key]');
    return g ? Number(g.getAttribute("opacity") ?? "1") : 1;
  });
  expect(faded, "the highlighted branch must not be dimmed out").toBeGreaterThan(0.15);
});
