import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "../compress/types"
import { createCompressRangeTool } from "../compress/range"
import { getConfig } from "../config"
import { createSystemPromptHandler } from "../hooks"
import { Logger } from "../logger"
import { assignMessageRefs } from "../message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectMessageIds,
    prune,
    stripHallucinations,
    syncCompressionBlocks,
} from "../messages"
import { PromptStore } from "../prompts/store"
import { createSessionState, syncToolCache, type SessionState, type WithParts } from "../state"
import { countTokens } from "../token-utils"
import {
    compressWireDef,
    findCompressCalls,
    offeredCompressName,
    rewriteCompressResult,
    rewriteOfferedCompressDef,
} from "./compress-router"
import { fromWire, toWire, type AnthropicBlock, type AnthropicRequest, type WireMeta } from "./wire"

// Read by the proxy from request headers.
export interface RequestContext {
    sessionId: string
    requestClass?: string
    window?: number
}

// A main response's usage, as the API reports it. It sizes the next request the
// way OpenCode's per-message tokens do.
export interface Usage {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
}

const SKIP_CLASSES = new Set(["compaction", "auxiliary"])
const CLAUDE_DEFAULT_WINDOW = 200_000

export function modelWindow(modelId: string, override?: number): number | undefined {
    if (typeof override === "number" && override > 0) return override
    if (/claude|haiku|sonnet|opus/i.test(modelId)) return CLAUDE_DEFAULT_WINDOW
    return undefined
}

export class ClaudeAdapter {
    private readonly config: ReturnType<typeof getConfig>
    private readonly logger: Logger
    private readonly prompts: PromptStore
    private readonly sessions = new Map<string, SessionState>()
    // Executed compress calls per session, so each runs once.
    private readonly compress = new Map<string, { done: Set<string>; ack: Map<string, string> }>()
    private readonly usage = new Map<string, Usage>()

    constructor() {
        const dir = process.cwd()
        this.config = getConfig({
            directory: dir,
            client: { tui: { showToast: async () => {} } },
        })
        this.logger = new Logger(this.config.debug)
        this.prompts = new PromptStore(
            this.logger,
            dir,
            this.config.experimental.customPrompts,
            "compact",
        )
    }

    private stateFor(sessionId: string): SessionState {
        let state = this.sessions.get(sessionId)
        if (!state) {
            // Same id format as the PromptStore, as in the V2 host.
            state = createSessionState("compact")
            this.sessions.set(sessionId, state)
        }
        return state
    }

    // Stub client serving the converted transcript.
    private clientFor(messages: WithParts[]) {
        return {
            session: {
                get: async () => ({
                    data: {
                        id: messages[0]?.info.sessionID ?? "",
                        agent: "build",
                        permissions: [],
                    },
                }),
                messages: async () => ({ data: messages }),
                prompt: async () => {},
            },
            tui: { showToast: async () => {} },
        }
    }

    get enabled(): boolean {
        return this.config.enabled
    }

    setUsage(sessionId: string, usage: Usage): void {
        this.usage.set(sessionId, usage)
    }

    // A request the proxy sent unmodified because apply() threw.
    reportError(error: unknown): void {
        this.logger.error("Claude adapter failed; request sent unmodified", {
            error: error instanceof Error ? error.message : String(error),
        })
    }

    async apply(request: AnthropicRequest, ctx: RequestContext): Promise<AnthropicRequest> {
        if (!this.config.enabled) return request
        if (ctx.requestClass && SKIP_CLASSES.has(ctx.requestClass)) return request
        if (ctx.requestClass === "subagent" && !this.config.experimental.allowSubAgents)
            return request

        const model = typeof request.model === "string" ? request.model : ""
        const window = modelWindow(model, ctx.window)
        const state = this.stateFor(ctx.sessionId)
        state.sessionId = ctx.sessionId
        state.modelContextLimit = window
        if (state.compressPermission === undefined) state.compressPermission = "allow"

        const { messages, meta } = toWire(request, ctx.sessionId)
        this.synthesizeTokens(ctx.sessionId, messages, request)

        // Before the refs are reassigned, so the call's ids still resolve.
        await this.routeCompress(messages, state, ctx.sessionId)

        const offered = offeredCompressName(request.tools)
        const definition = this.compressTool(messages, state)
        const jsonSchema = tool.schema.toJSONSchema(
            tool.schema.object(definition.args as Parameters<typeof tool.schema.object>[0]),
        ) as Record<string, unknown>
        delete jsonSchema.$schema
        const def = compressWireDef(String(definition.description ?? ""), jsonSchema)
        const tools =
            offered !== undefined
                ? rewriteOfferedCompressDef(request.tools, def.description, def.input_schema)
                : [...(Array.isArray(request.tools) ? request.tools : []), def]

        // Same order as lib/v2/index.ts; keep the two in step.
        stripHallucinations(messages, state.idFormat)
        assignMessageRefs(state, messages)
        syncCompressionBlocks(state, this.logger, messages)
        syncToolCache(state, this.config, this.logger, messages)
        buildToolIdList(state, messages)
        prune(state, this.logger, this.config, messages, this.summaryBase(ctx.sessionId))
        const priorities = buildPriorityMap(this.config, state, messages)
        this.prompts.reload()
        injectCompressNudges(
            state,
            this.config,
            this.logger,
            messages,
            this.prompts.getRuntimePrompts(),
            priorities,
            ctx.requestClass !== "compaction",
        )
        injectMessageIds(state, this.config, messages, priorities)

        const systemStrings = meta.systemBlocks.map((block) =>
            typeof block.text === "string" ? block.text : "",
        )
        const system = { system: systemStrings }
        await createSystemPromptHandler(
            state,
            this.logger,
            this.config,
            this.prompts,
        )({ sessionID: ctx.sessionId, model: { limit: { context: window ?? 0 } } }, system)

        const { messages: rebuilt } = fromWire(messages, meta)
        const next: AnthropicRequest = { ...request, messages: rebuilt }
        next.tools = tools
        const nextSystem = finalizeSystem(system.system, meta)
        if (nextSystem === undefined) delete next.system
        else next.system = nextSystem
        return next
    }

    private compressTool(messages: WithParts[], state: SessionState) {
        const ctx: ToolContext = {
            client: this.clientFor(messages),
            state,
            logger: this.logger,
            config: this.config,
            prompts: this.prompts,
        }
        return createCompressRangeTool(ctx)
    }

    private summaryBase(sessionId: string): WithParts {
        return {
            info: {
                id: "msg_dcp_base",
                role: "user",
                sessionID: sessionId,
                time: { created: 0 },
                model: { providerID: "anthropic", modelID: "", variant: undefined },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                summary: false,
            } as unknown as WithParts["info"],
            parts: [],
        }
    }

    // Nudges read context size from the last assistant's tokens: the API's usage
    // for the latest main response, or, before one arrives, an estimate of the
    // whole request (system prompt and tools included).
    private synthesizeTokens(
        sessionId: string,
        messages: WithParts[],
        request: AnthropicRequest,
    ): void {
        let last: WithParts | undefined
        for (const message of messages) if (message.info.role === "assistant") last = message
        if (last === undefined) return
        const usage = this.usage.get(sessionId) ?? {
            input: countTokens(
                JSON.stringify([request.system ?? "", request.tools ?? [], request.messages]),
            ),
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
        }
        ;(
            last.info as {
                tokens: {
                    input: number
                    output: number
                    reasoning: number
                    cache: { read: number; write: number }
                }
            }
        ).tokens = {
            input: usage.input,
            output: Math.max(1, usage.output),
            reasoning: 0,
            cache: { read: usage.cacheRead, write: usage.cacheWrite },
        }
    }

    private async routeCompress(
        messages: WithParts[],
        state: SessionState,
        sessionId: string,
    ): Promise<void> {
        const calls = findCompressCalls(messages)
        if (calls.length === 0) return
        let mem = this.compress.get(sessionId)
        if (!mem) {
            mem = { done: new Set(), ack: new Map() }
            this.compress.set(sessionId, mem)
        }
        const tool = this.compressTool(messages, state)
        type ExecuteContext = Parameters<typeof tool.execute>[1]
        for (const call of calls) {
            if (!mem.done.has(call.id)) {
                mem.done.add(call.id)
                // callID isn't in the SDK type, but the engine reads it.
                const toolCtx: ExecuteContext & { callID: string } = {
                    sessionID: sessionId,
                    messageID: call.messageId,
                    callID: call.id,
                    agent: "build",
                    directory: process.cwd(),
                    worktree: process.cwd(),
                    abort: new AbortController().signal,
                    ask: async () => {},
                    metadata: () => {},
                }
                try {
                    const content = await tool.execute(call.input, toolCtx)
                    mem.ack.set(call.id, typeof content === "string" ? content : "Compressed.")
                } catch (error) {
                    mem.ack.set(
                        call.id,
                        `Compress not applied: ${error instanceof Error ? error.message : String(error)}`,
                    )
                }
            }
            const ack = mem.ack.get(call.id)
            if (ack !== undefined) rewriteCompressResult(messages, call.id, ack)
        }
    }
}

// Each string keeps its original block's fields (cache_control etc.) by index.
function finalizeSystem(strings: string[], meta: WireMeta): string | AnthropicBlock[] | undefined {
    if (strings.length === 0) return undefined
    const blocks: AnthropicBlock[] = strings.map((text, i) => ({
        ...(meta.systemBlocks[i] ?? {}),
        type: "text",
        text,
    }))
    const [only] = blocks
    if (meta.systemWasString && blocks.length === 1 && only) return String(only.text ?? "")
    return blocks
}
