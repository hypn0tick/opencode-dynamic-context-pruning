import type { WithParts } from "../state"

export const COMPRESS_TOOL_NAME = "compress"
// The tool the plugin's mod registers (plugin "dcp"). Other servers' `*__compress`
// tools are unrelated and pass through untouched.
export const MOD_TOOL_NAME = "mcp__dcp__compress"

export interface CompressCall {
    id: string
    // Issuing message's info.id, used as the block origin. A tool callID is never
    // among the message ids, so syncCompressionBlocks would drop the block.
    messageId: string
    input: Record<string, unknown>
}

export interface WireToolDef {
    name: string
    description: string
    input_schema: unknown
}

function isCompressName(name: string): boolean {
    return name === COMPRESS_TOOL_NAME || name === MOD_TOOL_NAME
}

// The response-side rename for a request whose tools offered the mod's tool: the
// model calls the bare `compress` it was shown, renamed back so the mod answers.
export function responseRename(tools: unknown): { from: string; to: string } | undefined {
    return offeredCompressName(tools) === MOD_TOOL_NAME
        ? { from: COMPRESS_TOOL_NAME, to: MOD_TOOL_NAME }
        : undefined
}

type ToolPart = {
    type: string
    tool?: string
    callID?: string
    state?: { input?: unknown; output?: unknown; status?: string }
}

export function findCompressCalls(messages: WithParts[]): CompressCall[] {
    const calls: CompressCall[] = []
    for (const message of messages) {
        if (message.info.role !== "assistant") continue
        for (const part of message.parts as unknown as ToolPart[]) {
            if (
                part.type === "tool" &&
                typeof part.tool === "string" &&
                isCompressName(part.tool)
            ) {
                const input = (part.state?.input ?? {}) as Record<string, unknown>
                calls.push({
                    id: String(part.callID ?? ""),
                    messageId: String(message.info.id ?? ""),
                    input,
                })
            }
        }
    }
    return calls
}

export function rewriteCompressResult(messages: WithParts[], id: string, text: string): void {
    for (const message of messages) {
        for (const part of message.parts as unknown as ToolPart[]) {
            if (part.type === "tool" && String(part.callID ?? "") === id) {
                part.state = { ...part.state, status: "completed", output: text }
            }
        }
    }
}

export function offeredCompressName(tools: unknown): string | undefined {
    if (!Array.isArray(tools)) return undefined
    for (const tool of tools) {
        if (tool !== null && typeof tool === "object") {
            const name = (tool as { name?: unknown }).name
            if (typeof name === "string" && isCompressName(name)) return name
        }
    }
    return undefined
}

// Offers a mod's `*__compress` to the model as the bare `compress` the prompts
// name. The proxy restores the mod's name on the response.
export function rewriteOfferedCompressDef(
    tools: unknown,
    description: string,
    inputSchema: unknown,
): unknown {
    if (!Array.isArray(tools)) return tools
    return tools.map((tool) =>
        tool !== null &&
        typeof tool === "object" &&
        typeof (tool as { name?: unknown }).name === "string" &&
        isCompressName((tool as { name: string }).name)
            ? {
                  ...(tool as Record<string, unknown>),
                  name: COMPRESS_TOOL_NAME,
                  description,
                  input_schema: inputSchema,
              }
            : tool,
    )
}

export function compressWireDef(description: string, inputSchema: unknown): WireToolDef {
    return { name: COMPRESS_TOOL_NAME, description, input_schema: inputSchema }
}
