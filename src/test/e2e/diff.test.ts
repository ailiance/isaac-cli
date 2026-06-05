import { expect } from "@playwright/test"
import { E2E_WORKSPACE_TYPES, e2e } from "./utils/helpers"

// FIXME(ailiance): depends on signin → chat → diff round-trip. The signin
// step targets the removed onboarding screen. Re-enable once a fixture
// seeds a provider so the diff editor flow can be exercised directly.
e2e.describe.skip("Diff Editor", () => {
	E2E_WORKSPACE_TYPES.forEach(({ title, workspaceType }) => {
		e2e.extend({
			workspaceType,
		})(title, async ({ helper, page, sidebar }) => {
			await helper.signin(sidebar)

			const inputbox = sidebar.getByTestId("chat-input")
			await expect(inputbox).toBeVisible()

			await inputbox.fill("[diff.test.ts] Hello, Isaac!")
			await expect(inputbox).toHaveValue("[diff.test.ts] Hello, Isaac!")
			await sidebar.getByTestId("send-button").click()
			await expect(inputbox).toHaveValue("")

			// Back to home page with history
			await sidebar.getByRole("button", { name: "Start New Task" }).click()
			await expect(sidebar.getByText("Recent")).toBeVisible()
			await expect(sidebar.getByText("Hello, Isaac!")).toBeVisible() // History with the previous sent message

			// Submit a file edit request
			await sidebar.getByTestId("chat-input").click()
			await sidebar.getByTestId("chat-input").fill("edit_request")
			await sidebar.getByTestId("send-button").click({ delay: 50 })

			// Wait for the sidebar to load the file edit request
			await sidebar.waitForSelector('span:has-text("Isaac wants to edit this file:")')

			// Isaac Diff Editor should open with the file name and diff
			await expect(page.getByText("test.ts: Original ↔ Isaac's")).toBeVisible()

			// Diff editor should show the original and modified content
			const diffEditor = page.locator(
				".monaco-editor.modified-in-monaco-diff-editor > .overflow-guard > .monaco-scrollable-element.editor-scrollable > .lines-content > div:nth-child(4)",
			)
			await diffEditor.click()
			await expect(diffEditor).toBeVisible()

			await page.close()
		})
	})
})
