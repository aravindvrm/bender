import { expect, test } from "@playwright/test";

test("dashboard smoke flow", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agents" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();

  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

  await page.getByRole("button", { name: "Skill Library" }).click();
  await expect(page.getByText("Create skill package")).toBeVisible();

  const skillName = `pw-smoke-${Date.now()}`;
  await page.getByPlaceholder("Skill name (e.g. api-contract-qa)").fill(skillName);
  await page.getByRole("button", { name: "Create" }).first().click();

  await expect(page.getByText(`Created skill package: ${skillName}`)).toBeVisible();

  await page.getByRole("button", { name: "Refresh catalog" }).click();
  await expect(page.getByText("Skills refreshed.")).toBeVisible();
});
