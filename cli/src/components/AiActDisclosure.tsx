/**
 * EU AI Act Article 50 — Transparency Disclosure
 * Shown at interactive startup before the welcome view.
 */

import { Box, Text, useInput } from "ink"
// biome-ignore lint/correctness/noUnusedImports: required by tsconfig jsx: "react"
import React from "react"
import type { FunctionComponent } from "react"

interface AiActDisclosureProps {
	onAcknowledge: () => void
}

export const AiActDisclosure: FunctionComponent<AiActDisclosureProps> = ({ onAcknowledge }) => {
	useInput((_input, key) => {
		if (key.return) {
			onAcknowledge()
		}
	})

	return (
		<Box borderColor="yellow" borderStyle="round" flexDirection="column" paddingX={2} paddingY={1}>
			<Text bold color="yellow">
				EU AI Act Notice
			</Text>

			<Box flexDirection="column" marginTop={1}>
				<Text>ISAAC is an artificial intelligence system</Text>
				<Text>(EU AI Act, Article 50 — Transparency).</Text>
			</Box>

			<Box flexDirection="column" marginTop={1}>
				<Text>By continuing, you acknowledge that:</Text>

				<Box flexDirection="column" marginTop={1}>
					<Text>  • Outputs are AI-generated and may contain errors,</Text>
					<Text>    hallucinations, or insecure code. You are responsible</Text>
					<Text>    for reviewing every change before applying it.</Text>
				</Box>

				<Box flexDirection="column" marginTop={1}>
					<Text>  • Your prompts, code context, and tool outputs may be</Text>
					<Text>    transmitted to third-party LLM providers configured</Text>
					<Text>    in your settings.</Text>
				</Box>

				<Box flexDirection="column" marginTop={1}>
					<Text>  • Do not feed credentials, personal data, or regulated</Text>
					<Text>    information into the agent without prior review.</Text>
				</Box>
			</Box>

			<Box flexDirection="column" marginTop={1}>
				<Text>
					Press <Text bold>[Enter]</Text> to acknowledge and continue
				</Text>
				<Text>
					Press <Text bold>[Ctrl+C]</Text> to exit
				</Text>
			</Box>
		</Box>
	)
}
