# Dirac API

The Dirac extension exposes an API that can be used by other extensions. To use this API in your extension:

1. Copy `src/extension-api/dirac.d.ts` to your extension's source directory.
2. Include `dirac.d.ts` in your extension's compilation.
3. Get access to the API with the following code:

    ```ts
    const diracExtension = vscode.extensions.getExtension<IsaacAPI>("dirac-run.dirac")

    if (!diracExtension?.isActive) {
    	throw new Error("Dirac extension is not activated")
    }

    const dirac = diracExtension.exports

    if (dirac) {
    	// Now you can use the API

    	// Start a new task with an initial message
    	await dirac.startNewTask("Hello, Dirac! Let's make a new project...")

    	// Start a new task with an initial message and images
    	await dirac.startNewTask("Use this design language", ["data:image/webp;base64,..."])

    	// Send a message to the current task
    	await dirac.sendMessage("Can you fix the @problems?")

    	// Simulate pressing the primary button in the chat interface (e.g. 'Save' or 'Proceed While Running')
    	await dirac.pressPrimaryButton()

    	// Simulate pressing the secondary button in the chat interface (e.g. 'Reject')
    	await dirac.pressSecondaryButton()
    } else {
    	console.error("Dirac API is not available")
    }
    ```

    **Note:** To ensure that the `dirac-run.dirac` extension is activated before your extension, add it to the `extensionDependencies` in your `package.json`:

    ```json
    "extensionDependencies": [
        "dirac-run.dirac"
    ]
    ```

For detailed information on the available methods and their usage, refer to the `dirac.d.ts` file.
