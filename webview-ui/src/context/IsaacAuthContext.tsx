import type React from "react"
import { createContext, useContext } from "react"

// Define User type (you may need to adjust this based on your actual User type)
export interface IsaacUser {
	uid: string
	email?: string
	displayName?: string
	photoUrl?: string
	appBaseUrl?: string
}

export interface IsaacAuthContextType {
	diracUser: IsaacUser | null
	organizations: any[] | null
	activeOrganization: any | null
}

export const IsaacAuthContext = createContext<IsaacAuthContextType | undefined>(undefined)

export const IsaacAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	return (
		<IsaacAuthContext.Provider
			value={{
				diracUser: null,
				organizations: null,
				activeOrganization: null,
			}}>
			{children}
		</IsaacAuthContext.Provider>
	)
}

export const useIsaacAuth = () => {
	const context = useContext(IsaacAuthContext)
	if (context === undefined) {
		throw new Error("useIsaacAuth must be used within a IsaacAuthProvider")
	}
	return context
}

export const useIsaacSignIn = () => {
	return {
		isLoginLoading: false,
		handleSignIn: () => {},
	}
}

export const handleSignOut = async () => {}
