/**
 * Constants and utilities for Isaac extension and CLI.
 */

export const getExtensionSourceDir = () => {
	const isStandalone = process.env.IS_STANDALONE === "true"
	const isCli = process.env.IS_CLI === "true"
	const destDir = isStandalone && !isCli ? "dist-standalone" : "dist"
	return `${destDir}/source`
}
