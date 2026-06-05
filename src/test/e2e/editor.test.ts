import { expect } from "@playwright/test"
import { addSelectedCodeToIsaacWebview, openTab, toggleNotifications } from "./utils/common"
import { E2E_WORKSPACE_TYPES, e2e } from "./utils/helpers"

// FIXME(ailiance): depends on signin → chat round-trip. The signin step
// targets the removed onboarding screen. Re-enable once a fixture seeds
// a provider so editor code-actions can be tested directly.
e2e.describe.skip("Code Actions and Editor Panel", () => {
	E2E_WORKSPACE_TYPES.forEach(({ title, workspaceType }) => {
		e2e.extend({
			workspaceType,
		})(title, async ({ helper, page, sidebar }) => {
			await helper.signin(sidebar)
			// Sidebar - input should start empty
			const sidebarInput = sidebar.getByTestId("chat-input")
			await sidebarInput.click()
			await toggleNotifications(page)
			await expect(sidebarInput).toBeEmpty()

			// Open file tree and select code from file
			await openTab(page, "Explorer ")
			await page.getByRole("treeitem", { name: "index.html" }).locator("a").click()
			await expect(sidebarInput).not.toBeFocused()

			// Sidebar should be opened and visible after adding code to Isaac
			await addSelectedCodeToIsaacWebview(page)
			await expect(sidebarInput).not.toBeEmpty()
			await expect(sidebarInput).toBeFocused()
		})
	})
})
