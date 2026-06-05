import { BooleanRequest, EmptyRequest } from "@shared/proto/isaac/common"
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react"
import { useState } from "react"
import { StackServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { Switch } from "@/shared/ui/switch"
import { useStackStore } from "../store/stackStore"

interface StackRuntimeProps {
	onRefresh: () => void
}

export function StackRuntime({ onRefresh }: StackRuntimeProps) {
	const { snapshot, loading } = useStackStore()
	const [actionLoading, setActionLoading] = useState(false)
	const [actionError, setActionError] = useState<string | null>(null)

	const useLocalStack = snapshot?.useLocalStack ?? false
	const proxy = snapshot?.proxy
	const router = snapshot?.router

	async function handleToggleLocalStack(enabled: boolean) {
		try {
			await StackServiceClient.setUseLocalStack(BooleanRequest.create({ value: enabled }))
			onRefresh()
		} catch (e: any) {
			setActionError(e?.message ?? "Failed to update setting")
		}
	}

	async function handleAction(action: "start" | "stop" | "restart") {
		setActionLoading(true)
		setActionError(null)
		try {
			const req = EmptyRequest.create({})
			const result =
				action === "start"
					? await StackServiceClient.startStack(req)
					: action === "stop"
						? await StackServiceClient.stopStack(req)
						: await StackServiceClient.restartStack(req)
			if (!result.ok) {
				setActionError(result.message)
			}
		} catch (e: any) {
			setActionError(e?.message ?? `Failed to ${action} stack`)
		} finally {
			setActionLoading(false)
			onRefresh()
		}
	}

	return (
		<div className="space-y-4">
			{/* useLocalStack toggle */}
			<div className="flex items-center justify-between rounded-md border border-vscode-panel-border p-3">
				<div>
					<div className="font-medium text-vscode-foreground">Use local stack</div>
					<div className="text-xs text-vscode-descriptionForeground">
						Route LLM requests through your local LiteLLM proxy
					</div>
				</div>
				<Switch checked={useLocalStack} onCheckedChange={handleToggleLocalStack} />
			</div>

			{/* Process status cards */}
			<div className="grid grid-cols-2 gap-3">
				<ProcessCard label="LiteLLM Proxy" status={proxy} />
				<ProcessCard label="Jina Router" status={router} />
			</div>

			{/* Action buttons */}
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="secondary"
					onClick={() => handleAction("start")}
					disabled={actionLoading || loading}>
					{actionLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
					Start
				</Button>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => handleAction("stop")}
					disabled={actionLoading || loading}>
					Stop
				</Button>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => handleAction("restart")}
					disabled={actionLoading || loading}>
					<RefreshCw className="mr-1 h-3 w-3" />
					Restart
				</Button>
			</div>

			{actionError && (
				<div className="flex items-center gap-2 rounded-md bg-vscode-inputValidation-errorBackground p-2 text-xs text-vscode-errorForeground">
					<AlertCircle className="h-3 w-3 flex-shrink-0" />
					{actionError}
				</div>
			)}
		</div>
	)
}

interface ProcessCardProps {
	label: string
	status: { running: boolean; url?: string; pid?: number; uptimeMs?: number } | undefined
}

function ProcessCard({ label, status }: ProcessCardProps) {
	const running = status?.running ?? false
	const uptime = status?.uptimeMs != null ? formatUptime(status.uptimeMs) : null

	return (
		<div className="rounded-md border border-vscode-panel-border p-3 space-y-1">
			<div className="flex items-center gap-2">
				{running ? (
					<CheckCircle2 className="h-4 w-4 text-vscode-testing-iconPassed" />
				) : (
					<XCircle className="h-4 w-4 text-vscode-errorForeground" />
				)}
				<span className="text-sm font-medium text-vscode-foreground">{label}</span>
			</div>
			<div className="text-xs text-vscode-descriptionForeground">
				{running ? (
					<>
						<div>
							Status: <span className="text-vscode-testing-iconPassed">UP</span>
						</div>
						{status?.url && <div>URL: {status.url}</div>}
						{status?.pid != null && <div>PID: {status.pid}</div>}
						{uptime && <div>Uptime: {uptime}</div>}
					</>
				) : (
					<span className="text-vscode-errorForeground">DOWN</span>
				)}
			</div>
		</div>
	)
}

function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ${s % 60}s`
	const h = Math.floor(m / 60)
	return `${h}h ${m % 60}m`
}
