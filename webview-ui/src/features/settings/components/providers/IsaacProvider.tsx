import { Mode } from "@shared/ExtensionMessage"
import { IsaacAccountInfoCard } from "../IsaacAccountInfoCard"
import IsaacModelPicker from "../IsaacModelPicker"

/**
 * Props for the IsaacProvider component
 */
interface IsaacProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Isaac provider configuration component
 */
export const IsaacProvider = ({ showModelOptions, isPopup, currentMode }: IsaacProviderProps) => {
	return (
		<div>
			{/* Isaac Account Info Card */}
			<div style={{ marginBottom: 14, marginTop: 4 }}>
				<IsaacAccountInfoCard />
			</div>

			{showModelOptions && (
				<>
					<IsaacModelPicker
						currentMode={currentMode}
						isPopup={isPopup}
						showProviderRouting={true}
					/>
				</>
			)}
		</div>
	)
}
