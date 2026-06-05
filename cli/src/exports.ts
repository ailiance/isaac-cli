/**
 * ISAAC Library Exports
 *
 * This file exports the public API for programmatic use of ISAAC.
 * Use these classes and types to embed ISAAC into your applications.
 *
 * @example
 * ```typescript
 * import { IsaacAgent } from "isaac-cli"
 *
 * const agent = new IsaacAgent()
 * await agent.initialize({ clientCapabilities: {} })
 * const session = await agent.newSession({ cwd: process.cwd() })
 * ```
 * @module isaac-cli
 */

export { IsaacAgent } from "./agent/IsaacAgent.js"
export { IsaacSessionEmitter } from "./agent/IsaacSessionEmitter.js"
export type {
	AcpAgentOptions,
	AcpSessionState,
	AcpSessionStatus,
	Agent,
	AgentSideConnection,
	AudioContent,
	CancelNotification,
	ClientCapabilities,
	IsaacAcpSession,
	IsaacAgentCapabilities,
	IsaacAgentInfo,
	IsaacAgentOptions,
	IsaacPermissionOption,
	IsaacSessionEvents,
	ContentBlock,
	ImageContent,
	InitializeRequest,
	InitializeResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	ModelInfo,
	NewSessionRequest,
	NewSessionResponse,
	PermissionHandler,
	PermissionOption,
	PermissionOptionKind,
	PromptRequest,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionModelState,
	SessionNotification,
	SessionUpdate,
	SessionUpdatePayload,
	SessionUpdateType,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
	SetSessionModelRequest,
	SetSessionModelResponse,
	SetSessionModeRequest,
	SetSessionModeResponse,
	StopReason,
	TextContent,
	ToolCall,
	ToolCallStatus,
	ToolCallUpdate,
	ToolKind,
	TranslatedMessage,
} from "./agent/public-types.js"
