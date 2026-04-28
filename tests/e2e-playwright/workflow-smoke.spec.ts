import { expect, test } from "@playwright/test";

/**
 * Workflow smoke tests.
 *
 * IMPORTANT: The server auto-seeds three built-in workflows on every project
 * (issue-extract-candidates, task-to-implement, review-current-changes) via
 * ensureBuiltinWorkflows(). Tests MUST assume these are present — do not
 * assert on "No workflows found." in a freshly initialised project.
 *
 * We also install a dialog auto-accept handler because the "New" and "Delete"
 * buttons issue window.confirm() when there are unsaved edits; Playwright
 * defaults to dismissing dialogs, which would make tests return early.
 */

// One of the auto-seeded built-in workflows (stable across CI runs).
const BUILTIN_WORKFLOW_NAME = "Task -> Implement";

test.beforeEach(async ({ page }) => {
  // Accept any confirm() dialogs (e.g. "Discard unsaved workflow edits?").
  page.on("dialog", (dialog) => { void dialog.accept(); });
});

test("workflows view loads and shows list panel", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Workflows" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();

  // The left panel with the search box must be present.
  const searchBox = page.getByPlaceholder("Search workflows...");
  await expect(searchBox).toBeVisible({ timeout: 8000 });

  // Wait for the list to finish loading and at least one built-in workflow
  // (auto-seeded by the server) to appear. This is our guaranteed signal that
  // the list panel has populated correctly.
  await expect(page.getByText(BUILTIN_WORKFLOW_NAME)).toBeVisible({ timeout: 8000 });
});

test("create new workflow draft and save it", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Workflows" }).click();

  // Wait for the editor panel header.
  await expect(page.getByText("Workflow Editor")).toBeVisible({ timeout: 8000 });

  // Also wait for the list to populate so subsequent "appears in list" check
  // has a deterministic baseline.
  await expect(page.getByText(BUILTIN_WORKFLOW_NAME)).toBeVisible({ timeout: 8000 });

  // Click "New workflow" to create a draft. The confirm() dialog (if any) is
  // auto-accepted by the beforeEach handler. The button has aria-label="New workflow"
  // to distinguish it from the chat panel's "New conversation" button.
  await page.getByRole("button", { name: "New workflow" }).click();

  // The editor should now show the draft's Name and ID fields.
  const nameInput = page.locator('label:has-text("Name") input');
  await expect(nameInput).toBeVisible({ timeout: 4000 });

  const wfName = `pw-smoke-${Date.now()}`;
  await nameInput.fill(wfName);

  const idInput = page.locator('label:has-text("ID") input');
  await expect(idInput).toBeVisible();
  const wfId = `pw-smoke-id-${Date.now()}`;
  await idInput.fill(wfId);

  // Save the workflow.
  await page.getByRole("button", { name: "Save" }).click();

  // Success message should appear.
  await expect(page.getByText(`Workflow '${wfName}' saved.`)).toBeVisible({ timeout: 8000 });

  // The workflow should now appear in the left list panel (aside). Scope the
  // lookup there so the success banner in the main column does not cause a
  // strict-mode match-both collision.
  await expect(page.locator("aside").getByText(wfName)).toBeVisible({ timeout: 4000 });
});

test("workflow search filters the list", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Workflows" }).click();

  const searchBox = page.getByPlaceholder("Search workflows...");
  await expect(searchBox).toBeVisible({ timeout: 8000 });

  // Wait for the auto-seeded built-in to appear — our baseline signal that
  // the list has finished loading.
  const builtin = page.getByText(BUILTIN_WORKFLOW_NAME);
  await expect(builtin).toBeVisible({ timeout: 8000 });

  // Type a query that cannot match anything.
  await searchBox.fill("zzz-no-match-xyz-unique");

  // "No workflows found." is the only matcher that appears for non-empty
  // server state + no-match search.
  await expect(page.getByText("No workflows found.")).toBeVisible({ timeout: 4000 });
  await expect(builtin).not.toBeVisible();

  // Clear the search — built-in should re-appear.
  await searchBox.fill("");
  await expect(builtin).toBeVisible({ timeout: 4000 });
});
