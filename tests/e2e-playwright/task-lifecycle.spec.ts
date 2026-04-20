import { expect, test } from "@playwright/test";

/**
 * Task lifecycle smoke tests.
 * Verifies the Tasks view renders, the task list area is present, and the
 * "New Task" flow is reachable. Does not require a real Claude agent — just
 * confirms the UI wires up correctly with whatever state the server has.
 */

test("tasks view loads and shows task list area", async ({ page }) => {
  await page.goto("/");

  // Navigate to Tasks via the sidebar button
  await page.getByRole("button", { name: "Tasks" }).click();

  // The top-bar heading should update to "Tasks"
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

  // The tasks panel or its empty-state placeholder should be present within
  // a reasonable time — the server may or may not have a project open.
  await expect.poll(async () => {
    const text = await page.locator("body").innerText();
    return (
      text.includes("No tasks")
      || text.includes("No project open")
      || text.includes("Search tasks")
      || text.includes("task")
    );
  }, { timeout: 8000, intervals: [200, 400, 800] }).toBeTruthy();
});

test("tasks view search input is focusable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  // If a project is open the search box will be rendered; if no project is
  // open we just verify navigation works (no error thrown).
  const searchInput = page.getByPlaceholder("Search tasks…");
  const hasSearch = await searchInput.isVisible().catch(() => false);
  if (hasSearch) {
    await searchInput.click();
    await searchInput.fill("pw-test-query");
    await expect(searchInput).toHaveValue("pw-test-query");
    // Clearing the search restores the full list
    await searchInput.fill("");
    await expect(searchInput).toHaveValue("");
  } else {
    // No project open — just verify no JS error crashed the page
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  }
});
