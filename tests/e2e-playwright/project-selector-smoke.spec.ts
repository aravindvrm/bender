import { expect, test } from "@playwright/test";

test("project selector explorer loads directories", async ({ page }) => {
  await page.goto("/");

  const projectButton = page.locator('button[title^="Project:"]').first();
  await expect(projectButton).toBeVisible();
  await projectButton.click();

  const explorerToggle = page.getByRole("button", { name: "Explorer" });
  await expect(explorerToggle).toBeVisible();
  await explorerToggle.click();

  await expect.poll(async () => {
    const text = await page.locator("body").innerText();
    return (
      text.includes(". (this directory)")
      || text.includes("No subdirectories")
      || text.includes("Could not open")
      || text.includes("Path does not exist")
      || text.includes("Path is not a directory")
      || text.includes("Loading directories…")
    );
  }, {
    timeout: 8000,
    intervals: [150, 300, 500],
  }).toBeTruthy();
});

test("project selector open path fails fast with visible error", async ({ page }) => {
  await page.goto("/");

  const projectButton = page.locator('button[title^="Project:"]').first();
  await expect(projectButton).toBeVisible();
  await projectButton.click();

  const input = page.locator('input[placeholder="/path/to/project"]').first();
  await expect(input).toBeVisible();
  const openButton = input.locator("xpath=following-sibling::button[1]");
  await expect(openButton).toBeVisible();

  const missingPath = `/tmp/bender-missing-${Date.now()}`;
  await input.fill(missingPath);
  await openButton.click();

  await expect.poll(async () => {
    const text = await page.locator("body").innerText();
    return (
      text.includes("Directory does not exist")
      || text.includes("Request timed out")
      || text.includes("Failed to open project")
    );
  }, {
    timeout: 20_000,
    intervals: [200, 400, 800],
  }).toBeTruthy();

  await expect(openButton).toHaveText("Open");
});
