import { expect, test } from "@playwright/test";

/**
 * Chat smoke tests.
 *
 * Chat lives in the OperationDrawer at the bottom of the page — there is no
 * dedicated "Chat" nav button. The drawer is open on load and always contains
 * the ChatPanel (conversation switcher + composer + message list).
 */

test.describe("chat view smoke", () => {
  test("chat drawer is visible with conversation switcher", async ({ page }) => {
    await page.goto("/");

    // The conversation switcher button is always present in the drawer header
    const switcher = page.getByTitle("Switch conversation");
    await expect(switcher).toBeVisible({ timeout: 8000 });
  });

  test("chat drawer shows composer", async ({ page }) => {
    await page.goto("/");

    // The message textarea is present in the drawer
    const composer = page.getByRole("textbox");
    await expect(composer).toBeVisible({ timeout: 8000 });
  });

  test("new conversation button creates and selects a thread", async ({ page }) => {
    await page.goto("/");

    const newBtn = page.getByTitle("New conversation (⌘K)");
    await expect(newBtn).toBeVisible({ timeout: 8000 });
    await newBtn.click();

    // After clicking new, the conversation switcher should remain visible
    const switcher = page.getByTitle("Switch conversation");
    await expect(switcher).toBeVisible({ timeout: 4000 });

    // Composer should still be usable
    const composer = page.getByRole("textbox");
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();
  });

  test("conversation picker opens and lists threads", async ({ page }) => {
    await page.goto("/");

    // Create a thread first so there is something to list
    const newBtn = page.getByTitle("New conversation (⌘K)");
    await expect(newBtn).toBeVisible({ timeout: 8000 });
    await newBtn.click();

    // Open the picker
    const switcher = page.getByTitle("Switch conversation");
    await expect(switcher).toBeVisible({ timeout: 4000 });
    await switcher.click();

    // The picker dropdown should appear, showing "Conversations" heading
    await expect(page.getByText("Conversations")).toBeVisible({ timeout: 4000 });
  });

  test("conversation picker closes on Escape", async ({ page }) => {
    await page.goto("/");

    const newBtn = page.getByTitle("New conversation (⌘K)");
    await expect(newBtn).toBeVisible({ timeout: 8000 });
    await newBtn.click();

    // Open picker
    const switcher = page.getByTitle("Switch conversation");
    await switcher.click();
    await expect(page.getByText("Conversations")).toBeVisible({ timeout: 4000 });

    // Escape should close the picker
    await page.keyboard.press("Escape");
    await expect(page.getByText("Conversations")).not.toBeVisible({ timeout: 2000 });
  });

  test("chat composer accepts typed text", async ({ page }) => {
    await page.goto("/");

    const newBtn = page.getByTitle("New conversation (⌘K)");
    await expect(newBtn).toBeVisible({ timeout: 8000 });
    await newBtn.click();

    const composer = page.getByRole("textbox");
    await expect(composer).toBeVisible({ timeout: 4000 });

    await composer.fill("Hello world");
    await expect(composer).toHaveValue("Hello world");
  });
});
