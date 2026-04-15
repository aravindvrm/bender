import { expect, test } from "@playwright/test";

test("github issue import smoke flow", async ({ page, request }) => {
  const seed = await request.post("/api/tasks/append", {
    data: {
      title: "Seed task for Playwright",
      description: "Enable task plan view",
    },
  });
  expect(seed.ok()).toBeTruthy();

  await page.goto("/");

  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Task Plan" })).toBeVisible();

  await page.getByRole("button", { name: "Import Issues" }).click();
  await expect(page.getByRole("heading", { name: "Import From GitHub Issues" })).toBeVisible();
  await expect(page.getByText("Not connected to GitHub")).toBeVisible();
});

