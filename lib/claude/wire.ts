import type { WithParts } from "../state"

export type AnthropicBlock = { type: string } & Record<string, unknown>

export interface AnthropicMessage {
    role: "user" | "assistant" | "system"
    content: string | AnthropicBlock[]
    [key: string]: unknown
}

export interface AnthropicRequest {
    system?: string | AnthropicBlock[]
    messages: AnthropicMessage[]
    model?: unknown
    tools?: unknown
    [key: string]: unknown
}

type Part = WithParts["parts"][number]

interface GroupMeta {
    role: "user" | "assistant" | "system"
    blocks: AnthropicBlock[]
    rest: Record<string, unknown>
    resultText: Map<string, string>
    contentWasString: boolean
    // A user message that was only tool_results, folded into assistant tool parts.
    folded?: boolean
    // Kept out of the engine and re-emitted verbatim.
    pinned?: boolean
}

export interface WireMeta {
    groups: GroupMeta[]
    systemBlocks: AnthropicBlock[]
    systemWasString: boolean
    systemCount: number
}

export interface ToWireResult {
    messages: WithParts[]
    meta: WireMeta
}

const GROUP_PREFIX = "claude:g"
const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as const

function asBlocks(content: string | AnthropicBlock[]): AnthropicBlock[] {
    if (typeof content === "string") return [{ type: "text", text: content }]
    return content
}

function blockText(block: AnthropicBlock): string {
    return typeof block.text === "string" ? block.text : ""
}

function toolResultText(block: AnthropicBlock): string {
    const content = block.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
        return content
            .map((item) =>
                item && typeof item === "object" && (item as AnthropicBlock).type === "text"
                    ? blockText(item as AnthropicBlock)
                    : "",
            )
            .join("")
    }
    return ""
}

function infoFor(
    index: number,
    role: "user" | "assistant",
    request: AnthropicRequest,
    sessionId: string,
): WithParts["info"] {
    const modelID = typeof request.model === "string" ? request.model : ""
    return {
        id: `${GROUP_PREFIX}${index}`,
        role,
        sessionID: sessionId,
        time: { created: Date.now() },
        model: { providerID: "anthropic", modelID, variant: undefined },
        providerID: "anthropic",
        modelID,
        tokens: { ...emptyTokens },
        summary: false,
    } as unknown as WithParts["info"]
}

// The engine keeps a tool call and its result on one assistant part, so a user
// message holding only tool_results is folded into the assistant before it and
// rebuilt in fromWire. Message ids are "claude:g<n>"; anything else was added by
// the engine.
//
// The first user message carries Claude Code's CLAUDE.md and memory context, so it
// is pinned: the engine never sees it and cannot compress it.
export function toWire(request: AnthropicRequest, sessionId: string): ToWireResult {
    const groups: GroupMeta[] = []
    const messages: WithParts[] = []
    const first = request.messages[0]
    const pinned =
        first?.role === "user" && !asBlocks(first.content).some((b) => b.type === "tool_result")

    const resultById = new Map<string, { text: string; isError: boolean }>()
    for (const message of request.messages) {
        if (message.role !== "user") continue
        for (const block of asBlocks(message.content)) {
            if (block.type === "tool_result") {
                resultById.set(String(block.tool_use_id ?? ""), {
                    text: toolResultText(block),
                    isError: block.is_error === true,
                })
            }
        }
    }

    request.messages.forEach((message, index) => {
        const blocks = asBlocks(message.content)
        const { role, content, ...rest } = message
        const resultText = new Map<string, string>()
        const base = { sessionID: sessionId, messageID: `${GROUP_PREFIX}${index}` }
        const group: GroupMeta = {
            role: role as GroupMeta["role"],
            blocks,
            rest,
            resultText,
            contentWasString: typeof content === "string",
        }
        groups.push(group)
        if (index === 0 && pinned) {
            group.pinned = true
            return
        }

        if (role === "assistant") {
            const parts: Part[] = [
                { ...base, id: `${base.messageID}:step`, type: "step-start" } as Part,
            ]
            blocks.forEach((block, bi) => {
                if (block.type === "tool_use") {
                    const id = String(block.id ?? "")
                    const result = resultById.get(id)
                    const state: Record<string, unknown> = { input: block.input }
                    if (result === undefined) state.status = "running"
                    else if (result.isError) {
                        state.status = "error"
                        state.error = result.text
                    } else {
                        state.status = "completed"
                        state.output = result.text
                    }
                    parts.push({
                        ...base,
                        id,
                        type: "tool",
                        callID: id,
                        tool: String(block.name ?? ""),
                        state,
                    } as Part)
                } else if (block.type === "text") {
                    parts.push({
                        ...base,
                        id: `${base.messageID}:${bi}`,
                        type: "text",
                        text: blockText(block),
                    } as Part)
                } else {
                    parts.push({
                        ...base,
                        id: `${base.messageID}:${bi}`,
                        type: "claude-opaque",
                        raw: block,
                    } as unknown as Part)
                }
            })
            messages.push({ info: infoFor(index, "assistant", request, sessionId), parts })
            return
        }

        if (role === "user") {
            const parts: Part[] = []
            blocks.forEach((block, bi) => {
                if (block.type === "tool_result") {
                    resultText.set(String(block.tool_use_id ?? ""), toolResultText(block))
                    return // folded into the matching assistant tool part
                }
                if (block.type === "text") {
                    parts.push({
                        ...base,
                        id: `${base.messageID}:${bi}`,
                        type: "text",
                        text: blockText(block),
                    } as Part)
                } else {
                    parts.push({
                        ...base,
                        id: `${base.messageID}:${bi}`,
                        type: "claude-opaque",
                        raw: block,
                    } as unknown as Part)
                }
            })
            if (parts.length > 0)
                messages.push({ info: infoFor(index, "user", request, sessionId), parts })
            else if (blocks.some((b) => b.type === "tool_result")) group.folded = true
        }
        // Kept in meta and re-emitted by fromWire.
    })

    const systemWasString = typeof request.system === "string"
    const systemBlocks = request.system === undefined ? [] : asBlocks(request.system)
    return {
        messages,
        meta: { groups, systemBlocks, systemWasString, systemCount: systemBlocks.length },
    }
}

function groupIndexOf(id: unknown): number | undefined {
    if (typeof id !== "string" || !id.startsWith(GROUP_PREFIX)) return undefined
    const digits = id.slice(GROUP_PREFIX.length).split(":", 1)[0] ?? ""
    if (!/^\d+$/.test(digits)) return undefined
    return Number(digits)
}

function partText(part: Part): string {
    return part.type === "text" ? ((part as { text?: string }).text ?? "") : ""
}

function syntheticMessage(parts: Part[]): AnthropicMessage {
    const text = parts
        .filter((p) => p.type === "text")
        .map(partText)
        .join("\n")
    return { role: "user", content: [{ type: "text", text }] }
}

// Surviving messages keep their original block order; only changed text and
// pruned tool outputs differ. Engine-added messages become user text messages.
export function fromWire(messages: WithParts[], meta: WireMeta): { messages: AnthropicMessage[] } {
    const byGroup = new Map<number, WithParts>()
    const stream: Array<{ kind: "group"; index: number } | { kind: "synthetic"; parts: Part[] }> =
        []
    // Tool outputs are edited on the assistant part but written to the user's tool_result.
    const toolOutput = new Map<string, { text: string; isError: boolean }>()

    for (const message of messages) {
        const index = groupIndexOf(message.info.id)
        if (index === undefined || meta.groups[index] === undefined) {
            stream.push({ kind: "synthetic", parts: message.parts })
            continue
        }
        byGroup.set(index, message)
        stream.push({ kind: "group", index })
        for (const part of message.parts) {
            if (part.type !== "tool") continue
            const p = part as {
                callID?: string
                state?: { status?: string; output?: unknown; error?: unknown }
            }
            const id = String(p.callID ?? "")
            if (p.state?.status === "error")
                toolOutput.set(id, { text: String(p.state.error ?? ""), isError: true })
            else
                toolOutput.set(id, {
                    text: typeof p.state?.output === "string" ? p.state.output : "",
                    isError: false,
                })
        }
    }

    // A folded tool_result message follows its assistant, if that survived.
    const foldedAfter = new Map<number, number[]>()
    meta.groups.forEach((group, i) => {
        if (!group.folded) return
        let anchor = i - 1
        while (anchor >= 0 && meta.groups[anchor]!.role === "system") anchor--
        foldedAfter.set(anchor, [...(foldedAfter.get(anchor) ?? []), i])
    })

    // The pinned message and system messages (hook output, reminders) go back
    // unchanged. The last system message holds Claude Code's cache breakpoint.
    const passthrough = meta.groups.flatMap((group, i) =>
        group.role === "system" || group.pinned ? [i] : [],
    )
    let next = 0
    const out: AnthropicMessage[] = []
    const flushPassthrough = (before: number) => {
        while (next < passthrough.length && passthrough[next]! < before) {
            const index = passthrough[next++]!
            out.push(rebuildMessage(meta.groups[index]!, undefined, toolOutput))
        }
    }

    // An engine-added message takes the place of the first message it replaced.
    const removed = meta.groups.flatMap((group, i) =>
        group.role === "system" || group.pinned || group.folded || byGroup.has(i) ? [] : [i],
    )
    let last = -1
    if (meta.groups[0]?.pinned) {
        flushPassthrough(1)
        last = 0
    }
    for (const entry of stream) {
        if (entry.kind === "synthetic") {
            const at = removed.find((i) => i > last)
            if (at !== undefined) flushPassthrough(at)
            out.push(syntheticMessage(entry.parts))
            continue
        }
        flushPassthrough(entry.index)
        last = entry.index
        const added: string[] = []
        const message = rebuildMessage(
            meta.groups[entry.index]!,
            byGroup.get(entry.index),
            toolOutput,
            added,
        )
        const folded = (foldedAfter.get(entry.index) ?? []).map((fi) =>
            rebuildMessage(meta.groups[fi]!, undefined, toolOutput),
        )
        // Text the engine added to a message with no text block for it (a nudge on
        // a tool-only turn) goes after that turn's tool results, leaving the
        // assistant's own blocks untouched; without results, after the message.
        if (added.length > 0) appendText(folded[0] ?? message, added)
        out.push(message, ...folded)
    }
    flushPassthrough(Infinity)
    restoreCacheBreakpoint(out, meta)
    return { messages: out }
}

function hasCacheControl(block: unknown): boolean {
    if (!block || typeof block !== "object") return false
    const { cache_control, content } = block as { cache_control?: unknown; content?: unknown }
    return cache_control !== undefined || (Array.isArray(content) && content.some(hasCacheControl))
}

function lastCacheControl(meta: WireMeta): unknown {
    for (let g = meta.groups.length - 1; g >= 0; g--) {
        const blocks = meta.groups[g]!.blocks
        for (let b = blocks.length - 1; b >= 0; b--) {
            const block = blocks[b]!
            if (block.cache_control !== undefined) return block.cache_control
            if (Array.isArray(block.content)) {
                const inner = (block.content as AnthropicBlock[]).findLast(
                    (item) => item && typeof item === "object" && item.cache_control !== undefined,
                )
                if (inner) return inner.cache_control
            }
        }
    }
    return undefined
}

// If pruning removed every cache_control marker, put the last one back on the
// final message so the history stays cached.
function restoreCacheBreakpoint(out: AnthropicMessage[], meta: WireMeta): void {
    const marker = lastCacheControl(meta)
    const last = out[out.length - 1]
    if (marker === undefined || last === undefined) return
    if (
        out.some(
            (message) => Array.isArray(message.content) && message.content.some(hasCacheControl),
        )
    )
        return
    const blocks = asBlocks(last.content).slice()
    const final = blocks[blocks.length - 1]
    if (final === undefined) return
    blocks[blocks.length - 1] = { ...final, cache_control: marker }
    last.content = blocks
}

function appendText(message: AnthropicMessage, texts: string[]): void {
    message.content = [
        ...asBlocks(message.content),
        ...texts.map((text) => ({ type: "text", text })),
    ]
}

// Text parts are matched to text blocks by position; text parts beyond the
// message's text blocks go to `added`. `edited` is absent for a folded
// tool_result message.
function rebuildMessage(
    group: GroupMeta,
    edited: WithParts | undefined,
    toolOutput: Map<string, { text: string; isError: boolean }>,
    added: string[] = [],
): AnthropicMessage {
    const texts = edited ? edited.parts.filter((p) => p.type === "text").map(partText) : []
    let t = 0
    const blocks: AnthropicBlock[] = []
    for (const block of group.blocks) {
        if (block.type === "tool_result") {
            const id = String(block.tool_use_id ?? "")
            const current = toolOutput.get(id)
            if (current === undefined || current.text === (group.resultText.get(id) ?? ""))
                blocks.push(block)
            else blocks.push({ ...block, content: current.text, is_error: current.isError })
            continue
        }
        if (block.type === "text") {
            const next = texts[t++]
            blocks.push(
                next === undefined || next === blockText(block) ? block : { ...block, text: next },
            )
            continue
        }
        blocks.push(block) // tool_use, thinking, and other blocks are not text-edited
    }
    added.push(...texts.slice(t))
    return { role: group.role, content: collapse(blocks, group.contentWasString), ...group.rest }
}

function collapse(blocks: AnthropicBlock[], wasString: boolean): string | AnthropicBlock[] {
    const [only] = blocks
    if (wasString && blocks.length === 1 && only && only.type === "text") return blockText(only)
    return blocks
}
