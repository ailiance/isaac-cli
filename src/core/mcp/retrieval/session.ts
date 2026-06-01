import type { ActiveMcpToolSet } from "./ActiveMcpToolSet"

let current: ActiveMcpToolSet | undefined

export function setActiveMcpToolSet(set: ActiveMcpToolSet | undefined): void {
	current = set
}

export function getActiveMcpToolSet(): ActiveMcpToolSet | undefined {
	return current
}
