import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

// FIXME(ailiance): rewrite against current UI.
// The onboarding flow this test exercised ("Login to Isaac" button →
// "Bring my own API key" → provider selector → "Sign Up with Isaac" →
// OpenRouter API key input → "What's New" dismiss) was removed when the
// webview was redesigned to be chat-first with no welcome view; the
// current UX puts API-key setup inside Settings reached via the gear icon.
// Skipping until tests are re-written for the current screens.
e2e.skip("Views - can set up API keys and navigate to Settings from Chat", async ({ sidebar }) => {
	// Use the page object to interact with editor outside the sidebar
	// Verify initial state
	await expect(sidebar.getByRole("button", { name: "Login to Isaac" })).toBeVisible()
	await expect(sidebar.getByText("Bring my own API key")).toBeVisible()

	// Navigate to API key setup
	await sidebar.getByText("Bring my own API key").click()
	await sidebar.getByRole("button", { name: "Continue" }).click()

	const providerSelectorInput = sidebar.getByTestId("provider-selector-input")

	// Verify provider selector is visible
	await expect(providerSelectorInput).toBeVisible()

	// Test Isaac provider option
	await providerSelectorInput.click({ delay: 100 })
	// Wait for dropdown to appear and find Isaac option
	await expect(sidebar.getByTestId("provider-option-dirac")).toBeVisible()
	await sidebar.getByTestId("provider-option-dirac").click({ delay: 100 })
	await expect(sidebar.getByRole("button", { name: "Sign Up with Isaac" })).toBeVisible()

	// Switch to OpenRouter and complete setup
	await providerSelectorInput.click({ delay: 100 })
	await sidebar.getByTestId("provider-option-openrouter").click({ delay: 100 })

	const apiKeyInput = sidebar.getByRole("textbox", {
		name: "OpenRouter API Key",
	})
	await apiKeyInput.fill("test-api-key")
	await expect(apiKeyInput).toHaveValue("test-api-key")
	await apiKeyInput.click({ delay: 100 })
	await sidebar.getByRole("button", { name: "Continue" }).click()

	await expect(sidebar.getByRole("button", { name: "Login to Isaac" })).not.toBeVisible()

	// Verify start up page is no longer visible
	await expect(apiKeyInput).not.toBeVisible()
	await expect(providerSelectorInput).not.toBeVisible()

	// Verify the "What's New" modal is visible for new installs and can be closed.
	const dialog = sidebar.getByRole("heading", {
		name: /^🎉 New in v\d/,
	})
	await expect(dialog).toBeVisible()
	await sidebar.getByRole("button", { name: "Close" }).click()
	await expect(dialog).not.toBeVisible()

	// Verify you are now in the chat page after setup was completed and the dialog was closed.
	// dirac logo container
	const diracLogo = sidebar.locator(".size-20")
	await expect(diracLogo).toBeVisible()
	const chatInputBox = sidebar.getByTestId("chat-input")
	await expect(chatInputBox).toBeVisible()

	// Verify What's New Section is showing and starts with first banner,
	// and the navigation buttons work
	const announcementsRegion = sidebar.locator('[aria-label="Announcements"]')
	await expect(announcementsRegion).toBeVisible()

	const pageIndicator = announcementsRegion
		.locator("div")
		.filter({ hasText: /^\d+ \/ \d+$/ })
		.first()
	await expect(pageIndicator).toBeVisible()

	const initialIndicator = (await pageIndicator.innerText()).trim()
	const totalBanners = Number(initialIndicator.split("/")[1]?.trim() || "0")

	if (totalBanners > 1) {
		await sidebar.getByRole("button", { name: "Next banner" }).click()
		await expect(pageIndicator).not.toHaveText(initialIndicator)
		await sidebar.getByRole("button", { name: "Previous banner" }).click()
		await expect(pageIndicator).toHaveText(initialIndicator)
	}
})
