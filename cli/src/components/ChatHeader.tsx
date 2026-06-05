import React, { useState, useEffect } from "react"
import { Box, Text } from "ink"
import { AsciiMotionCli, StaticRobotFrame } from "./AsciiMotionCli"
import { centerText } from "../utils/display"
import { osc8 } from "../utils/hyperlink"
import { version as CLI_VERSION } from "../../package.json"
import type { RoutingEvent } from "@/services/local-router/RoutingObserver"


interface ChatHeaderProps {
	isWelcomeState?: boolean
	quote?: string
	onInteraction?: (input: string, key: any) => void
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({ isWelcomeState, quote, onInteraction }) => {
	const [webuiUrl, setWebuiUrl] = useState<string | null>(null)
	const [routing, setRouting] = useState<RoutingEvent | null>(null)

	useEffect(() => {
		// Only spawn in interactive TTY mode
		if (!process.stdout.isTTY) return
		import("@/services/webui/WebuiServer")
			.then(({ webuiServer }) => webuiServer.start())
			.then((s) => {
				if (s.running && s.url) setWebuiUrl(s.url)
			})
			.catch(() => {})
	}, [])

	useEffect(() => {
		import("@/services/local-router/RoutingObserver")
			.then(({ routingObserver }) => {
				setRouting(routingObserver.last())
				return routingObserver.subscribe(setRouting)
			})
			.catch(() => {})
	}, [])

	const content = (
		<React.Fragment>
			{isWelcomeState ? (
				<AsciiMotionCli onInteraction={onInteraction} />
			) : (
				<StaticRobotFrame />
			)}
			<Text> </Text>
			<Text bold color="white">
				{centerText(`ISAAC v${CLI_VERSION} — EU-sovereign coding agent (fork of Isaac/Cline)`)}
			</Text>
			{webuiUrl && (
				<Box marginTop={0}>
					<Text dimColor>
						{centerText(`Web UI: ${osc8(webuiUrl, webuiUrl)}`)}
					</Text>
				</Box>
			)}
			{routing && (
				<Box marginTop={0}>
					<Text dimColor>
						{" → "}
						<Text>{routing.workerId}</Text>
						{" · "}
						<Text>{routing.category}</Text>
						{routing.cacheHit && (
							<React.Fragment>
								{" · "}
								<Text color="green">cache</Text>
							</React.Fragment>
						)}
						{" · "}
						<Text>~{routing.estTokens} tok</Text>
					</Text>
				</Box>
			)}
			{isWelcomeState && quote ? (
				<Box marginTop={1}>
					<Text color="cyan" italic>
						{centerText(`"${quote}"`)}
					</Text>
				</Box>
			) : (
				<Text> </Text>
			)}
		</React.Fragment>
	)

	return <Box flexDirection="column">{content}</Box>
}
