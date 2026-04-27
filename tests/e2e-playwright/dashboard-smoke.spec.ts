import { expect, test } from "@playwright/test";

test("dashboard smoke flow", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agents" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();

  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

  // Open the New Skill modal from the Skills section
  await page.getByRole("button", { name: "New Skill" }).click();
  await expect(page.getByRole("heading", { name: "New Skill" })).toBeVisible();

  const skillName = `pw-smoke-${Date.now()}`;
  await page.getByPlaceholder("e.g. api-contract-qa").fill(skillName);
  // Description is required to enable the Create Skill button
  await page.getByPlaceholder("When reviewing API changes").fill("Playwright smoke test skill.");
  await page.getByRole("button", { name: "Create Skill" }).click();

  await expect(page.getByText(`Skill '${skillName}' created.`)).toBeVisible();

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Skills refreshed.")).toBeVisible();
});
