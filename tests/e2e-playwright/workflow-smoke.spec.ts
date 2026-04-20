import { expect, test } from "@playwright/test";

/**
 * Workflow smoke tests.
 * Covers: navigate to Workflows, verify list panel renders, create a new
 * workflow draft, fill in a name, save it, and confirm it appears in the list.
 */

test("workflows view loads and shows list panel", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Workflows" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();

  // The left panel with the search box must be present
  const searchBox = page.getByPlaceholder("Search workflows...");
  await expect(searchBox).toBeVisible({ timeout: 8000 });

  // The list either shows existing workflows or the empty state
  await expect.poll(async () => {
    const text = await page.locator("body").innerText();
    return text.includes("No workflows found.") || text.includes("workflow-");
  }, { timeout: 8000, intervals: [200, 400, 800] }).toBeTruthy();
});

test("create new workflow draft and save it", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Workflows" }).click();

  // Wait for the editor panel header
  await expect(page.getByText("Workflow Editor")).toBeVisible({ timeout: 8000 });

  // Click "New" to create a draft
  await page.getByRole("button", { name: "New" }).click();

  // The editor should now show a draft with "New Workflow" as the default name
  const nameInput = page.locator('label:has-text("Name") input');
  await expect(nameInput).toBeVisible({ timeout: 4000 });

  // Set a unique name for the test workflow
  const wfName = `pw-smoke-${Date.now()}`;
  await nameInput.fill(wfName);

  // Also give it a unique ID to avoid collisions on repeated runs
  const idInput = page.locator('label:has-text("ID") input');
  await expect(idInput).toBeVisible();
  const wfId = `pw-smoke-id-${Date.now()}`;
  await idInput.fill(wfId);

  // Save the workflow
  await page.getByRole("button", { name: "Save" }).click();

  // Success message should appear
  await expect(page.getByText(`Workflow '${wfName}' saved.`)).toBeVisible({ timeout: 8000 });

  // The workflow should now appear in the left list panel
  await expect(page.getByText(wfName)).toBeVisible({ timeout: 4000 });
});

test("workflow search filters the list", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Workflows" }).click();

  const searchBox = page.getByPlaceholder("Search workflows...");
  await expect(searchBox).toBeVisible({ timeout: 8000 });

  // Type a query that is unlikely to match anything
  await searchBox.fill("zzz-no-match-xyz");

  await expect.poll(async () => {
    const text = await page.locator("body").innerText();
    return text.includes("No workflows found.");
  }, { timeout: 4000, intervals: [150, 300] }).toBeTruthy();

  // Clear and verify list re-populates (or stays at "No workflows found." if DB is empty)
  await searchBox.fill("");
  await expect.poll(async () => {
    const text = await page.locator("body").innerText();
    return text.includes("No workflows found.") || text.includes("workflow-") || text.includes("pw-smoke");
  }, { timeout: 4000, intervals: [150, 300] }).toBeTruthy();
});
