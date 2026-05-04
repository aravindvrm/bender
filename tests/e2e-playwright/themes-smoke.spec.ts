import { expect, test } from "@playwright/test";

test.describe("themes smoke", () => {
  test("settings view shows theme gallery with built-in themes", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // The ThemeSection renders under "Appearance" section header
    await expect(page.getByText("Appearance")).toBeVisible({ timeout: 8000 });

    // At least one theme card button should be visible (built-in themes auto-load)
    const themeCards = page.locator('button[class*="rounded-xl"][class*="border"]');
    await expect(themeCards.first()).toBeVisible({ timeout: 8000 });
    const count = await themeCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test("active theme has a ring indicator", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Appearance")).toBeVisible({ timeout: 8000 });

    // The active theme card has ring-1 ring-zinc-400/40 border-zinc-400 classes
    const activeCard = page.locator('button[class*="ring-1"]').first();
    await expect(activeCard).toBeVisible({ timeout: 8000 });
  });

  test("clicking a non-active built-in theme marks it active", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Appearance")).toBeVisible({ timeout: 8000 });

    // Wait for cards to render
    const allCards = page.locator('button[class*="rounded-xl"][class*="border"]');
    await expect(allCards.first()).toBeVisible({ timeout: 8000 });

    const count = await allCards.count();
    if (count < 2) return; // skip if only one theme

    // Find the first non-active card and click it
    for (let i = 0; i < count; i++) {
      const card = allCards.nth(i);
      const cls = await card.getAttribute("class") ?? "";
      if (!cls.includes("ring-1")) {
        await card.click();
        // After click, this card should gain the active ring
        await expect(card).toHaveClass(/ring-1/, { timeout: 4000 });
        break;
      }
    }
  });

  test("import button is visible and accepts a .json file", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Appearance")).toBeVisible({ timeout: 8000 });

    // Import button text includes "Import VS Code theme"
    const importBtn = page.getByRole("button", { name: /import vs code theme/i });
    await expect(importBtn.first()).toBeVisible({ timeout: 8000 });

    // Trigger file input via the hidden input element
    const fileInput = page.locator('input[type="file"][accept*="json"]');
    const minimalTheme = JSON.stringify({
      name: "PW Smoke Theme",
      type: "dark",
      colors: {
        "editor.background": "#1a1a2e",
        "editor.foreground": "#e0e0e0",
        "sideBar.background": "#16213e",
        "statusBar.background": "#0f3460",
      },
    });

    await fileInput.first().setInputFiles({
      name: "pw-smoke.json",
      mimeType: "application/json",
      buffer: Buffer.from(minimalTheme),
    });

    // A notice or the new theme card should appear
    // Either a "Theme imported" notice or the theme name appears in the list
    await expect(
      page.getByText(/imported|PW Smoke Theme/i).first(),
    ).toBeVisible({ timeout: 8000 });
  });
});
