import { Box, Text, useApp, useInput } from "ink"
import React, { useMemo, useState } from "react"
import { groupByDay, loadTimeline } from "../services/timeline-loader"

function fmtTime(ts: number): string {
	const d = new Date(ts)
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function fmtCost(cost: number): string {
	if (cost === 0) return ""
	if (cost < 0.01) return `${(cost * 100).toFixed(2)}¢`
	return `$${cost.toFixed(3)}`
}

export const TimelineView: React.FC<{ days?: number; limit?: number }> = ({ days = 30, limit = 200 }) => {
	const { exit } = useApp()
	const entries = useMemo(() => loadTimeline({ days, limit }), [days, limit])
	const groups = useMemo(() => groupByDay(entries), [entries])
	const [cursor, setCursor] = useState(0)

	useInput((input, key) => {
		if (input === "q" || key.escape) exit()
		if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
		if (key.downArrow) setCursor((c) => Math.min(entries.length - 1, c + 1))
	})

	if (entries.length === 0) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="yellow">No tasks found in ~/.dirac/data/state/taskHistory.json</Text>
				<Text dimColor>Run isaac and create a task to populate the timeline.</Text>
			</Box>
		)
	}

	let idx = 0
	return (
		<Box flexDirection="column" padding={1}>
			<Text>
				<Text color="cyan" bold>
					ISAAC timeline
				</Text>
				<Text dimColor>
					{" · "}
					{entries.length} tasks · last {days} days
				</Text>
			</Text>
			<Box marginTop={1} flexDirection="column">
				{Array.from(groups.entries()).map(([day, list]) => (
					<Box key={day} flexDirection="column" marginBottom={1}>
						<Text color="blue">{"### "}{day}</Text>
						{list.map((e) => {
							const i = idx++
							const selected = i === cursor
							return (
								<Box key={e.id}>
									<Text color={selected ? "yellowBright" : undefined}>
										{selected ? "▶ " : "  "}
										<Text dimColor>#{e.shortId}</Text>
										{"  "}
										<Text dimColor>{fmtTime(e.ts)}</Text>
										{"  "}
										{e.emoji}
										{"  "}
										{e.task}
										{e.totalCost ? (
											<Text dimColor>
												{"  "}
												{fmtCost(e.totalCost)}
											</Text>
										) : null}
									</Text>
								</Box>
							)
						})}
					</Box>
				))}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>[↑↓] navigate  [q] quit</Text>
			</Box>
		</Box>
	)
}
