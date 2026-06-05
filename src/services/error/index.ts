import { ErrorSettings } from "./providers/IErrorProvider"

export { IsaacError, IsaacErrorType } from "./IsaacError"
export { type ErrorProviderConfig, ErrorProviderFactory, type ErrorProviderType } from "./ErrorProviderFactory"
export { ErrorService } from "./ErrorService"
export type { ErrorSettings, IErrorProvider } from "./providers/IErrorProvider"
export { IsaacErrorProvider } from "./providers/IsaacErrorProvider"

export function getErrorLevelFromString(level: string | undefined): ErrorSettings["level"] {
	switch (level) {
		case "disabled":
		case "off":
			return "off"
		case "error":
		case "crash":
			return "error"
		default:
			return "all"
	}
}
