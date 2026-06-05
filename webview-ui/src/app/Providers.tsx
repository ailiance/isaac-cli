import { HeroUIProvider } from "@heroui/react"
import { TooltipProvider } from "@/shared/ui/tooltip"
import { type ReactNode } from "react"
import { IsaacAuthProvider } from "@/context/IsaacAuthContext"
import { PlatformProvider } from "@/context/PlatformContext"
export function Providers({ children }: { children: ReactNode }) {
	return (
		<PlatformProvider>
				<IsaacAuthProvider>
					<HeroUIProvider>
						<TooltipProvider>{children}</TooltipProvider>
					</HeroUIProvider>
				</IsaacAuthProvider>
		</PlatformProvider>
	)
}
