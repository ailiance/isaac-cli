import { EmptyRequest } from "@shared/proto/isaac/common"
import type { StackSnapshot } from "@shared/proto/isaac/stack"
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Server } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { StackServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import ViewHeader from "@/shared/ui/ViewHeader"
import { LogsViewer } from "./LogsViewer"
import { McpServersList } from "./McpServersList"
import { ModelsList } from "./ModelsList"
import { PluginsList } from "./PluginsList"
import { StackRuntime } from "./StackRuntime"
import { useStackStore } from "../store/stackStore"

const REFRESH_INTERVAL_MS = 10_000

type Section = "runtime" | "models" | "mcp" | "plugins" | "logs"

interface StackConfigViewProps {
	onDone: () => void
}

export function StackConfigView({ onDone }: StackConfigViewProps) {
	const { setSnapshot, setLoading, setError, loading } = useStackStore()
	const [expanded, setExpanded] = useState<Set<Section>>(new Set(["runtime"]))
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

	const refresh = useCallback(async () => {
		setLoading(true)
		try {
			const snapshot: StackSnapshot = await StackServiceClient.getStackSnapshot(EmptyRequest.create({}))
			setSnapshot(snapshot)
		} catch (e: any) {
			setError(e?.message ?? "Failed to load stack snapshot")
		} finally {
			setLoading(false)
		}
	}, [setLoading, setSnapshot, setError])

	// Initial load + polling
	useEffect(() => {
		refresh()
		intervalRef.current = setInterval(refresh, REFRESH_INTERVAL_MS)
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current)
		}
	}, [refresh])

	function toggle(section: Section) {
		setExpanded((prev) => {
			const next = new Set(prev)
			if (next.has(section)) {
				next.delete(section)
			} else {
				next.add(section)
			}
			return next
		})
	}

	return (
		<div className="flex flex-col h-screen overflow-hidden">
			<ViewHeader title="Stack & Plugins" onDone={onDone} />

			<div className="flex items-center gap-2 px-4 pb-2">
				<Server className="h-4 w-4 text-vscode-descriptionForeground" />
				<span className="text-xs text-vscode-descriptionForeground">
					Local stack monitoring — auto-refresh every 10s
				</span>
				<Button size="sm" variant="ghost" onClick={refresh} disabled={loading} className="ml-auto h-6 px-2">
					{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
				</Button>
			</div>

			<div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
				<CollapsibleSection
					title="Stack Runtime"
					sectionKey="runtime"
					expanded={expanded}
					onToggle={toggle}>
					<StackRuntime onRefresh={refresh} />
				</CollapsibleSection>

				<CollapsibleSection
					title="Available Models"
					sectionKey="models"
					expanded={expanded}
					onToggle={toggle}>
					<ModelsList />
				</CollapsibleSection>

				<CollapsibleSection
					title="MCP Servers"
					sectionKey="mcp"
					expanded={expanded}
					onToggle={toggle}>
					<McpServersList onRefresh={refresh} />
				</CollapsibleSection>

				<CollapsibleSection
					title="Plugins"
					sectionKey="plugins"
					expanded={expanded}
					onToggle={toggle}>
					<PluginsList />
				</CollapsibleSection>

				<CollapsibleSection
					title="Logs"
					sectionKey="logs"
					expanded={expanded}
					onToggle={toggle}>
					<LogsViewer />
				</CollapsibleSection>
			</div>
		</div>
	)
}

interface CollapsibleSectionProps {
	title: string
	sectionKey: Section
	expanded: Set<Section>
	onToggle: (s: Section) => void
	children: React.ReactNode
}

function CollapsibleSection({ title, sectionKey, expanded, onToggle, children }: CollapsibleSectionProps) {
	const isOpen = expanded.has(sectionKey)
	return (
		<div className="rounded-md border border-vscode-panel-border overflow-hidden">
			<button
				type="button"
				className="w-full flex items-center gap-2 px-4 py-3 bg-vscode-sideBar-background hover:bg-vscode-list-hoverBackground text-left"
				onClick={() => onToggle(sectionKey)}>
				{isOpen ? (
					<ChevronDown className="h-4 w-4 flex-shrink-0 text-vscode-descriptionForeground" />
				) : (
					<ChevronRight className="h-4 w-4 flex-shrink-0 text-vscode-descriptionForeground" />
				)}
				<span className="text-sm font-medium text-vscode-foreground">{title}</span>
			</button>
			{isOpen && <div className="px-4 pb-4 pt-2">{children}</div>}
		</div>
	)
}
