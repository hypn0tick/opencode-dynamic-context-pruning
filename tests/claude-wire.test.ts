import assert from "node:assert/strict"
import { test } from "node:test"

import { fromWire, toWire, type AnthropicRequest } from "../lib/claude/wire"

const SID = "ses_test"

test("lossless round trip for a text conversation", () => {
    const req: AnthropicRequest = {
        model: "claude-opus-4-8",
        messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ],
    }
    const { messages, meta } = toWire(req, SID)
    assert.deepEqual(fromWire(messages, meta).messages, req.messages)
})

test("tool_use pairs with its tool_result into one assistant tool part", () => {
    const req: AnthropicRequest = {
        messages: [
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a" } }],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
            },
        ],
    }
    const { messages, meta } = toWire(req, SID)
    assert.equal(messages.length, 1, "the tool-result-only user message yields no WithParts")
    const toolPart = messages[0]!.parts.find((p) => p.type === "tool") as any
    assert.equal(toolPart.callID, "t1")
    assert.equal(toolPart.state.status, "completed")
    assert.equal(toolPart.state.output, "file body")
    assert.deepEqual(
        fromWire(messages, meta).messages,
        req.messages,
        "splits back to assistant + user",
    )
})

test("a pruned tool output writes back into the tool_result", () => {
    const req: AnthropicRequest = {
        messages: [
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "t1", content: "huge body" }],
            },
        ],
    }
    const { messages, meta } = toWire(req, SID)
    const toolPart = messages[0]!.parts.find((p) => p.type === "tool") as any
    toolPart.state.output = "[pruned]"
    const back = fromWire(messages, meta).messages
    const userMsg = back.find((m) => m.role === "user")!
    assert.equal((userMsg.content as Array<Record<string, unknown>>)[0]!.content, "[pruned]")
})

test("a spliced message becomes a user text message", () => {
    const req: AnthropicRequest = { messages: [{ role: "user", content: "x" }] }
    const { messages, meta } = toWire(req, SID)
    const summary = {
        info: { id: "spliced", role: "user" } as any,
        parts: [{ type: "text", text: "[Compressed section]" } as any],
    }
    const back = fromWire([summary, ...messages], meta).messages
    assert.equal(back.length, 2)
    assert.deepEqual(back[0], req.messages[0])
    assert.deepEqual(back[1], {
        role: "user",
        content: [{ type: "text", text: "[Compressed section]" }],
    })
})

const BREAKPOINT = { type: "ephemeral", ttl: "1h" }

function hookedRequest(): AnthropicRequest {
    return {
        messages: [
            { role: "user", content: [{ type: "text", text: "Read big.txt" }] },
            { role: "system", content: "SessionStart hook additional context: x" },
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
            },
            { role: "system", content: "PreToolUse:Read hook additional context: y" },
            {
                role: "system",
                content: [
                    {
                        type: "text",
                        text: "<total_tokens>9</total_tokens>",
                        cache_control: BREAKPOINT,
                    },
                ],
            },
        ],
    }
}

test("mid-conversation system messages and their cache breakpoint round-trip", () => {
    const req = hookedRequest()
    const { messages, meta } = toWire(req, SID)
    assert.deepEqual(fromWire(messages, meta).messages, req.messages)
})

test("the first user message is kept out of the engine", () => {
    const req = hookedRequest()
    const { messages } = toWire(req, SID)
    assert.equal(messages[0]!.info.role, "assistant")
    assert.equal(messages.length, 1)
})

test("a summary replacing the messages after the pinned one keeps the opening order", () => {
    const req = hookedRequest()
    const { meta } = toWire(req, SID)
    const summary = {
        info: { id: "spliced", role: "user" } as any,
        parts: [{ type: "text", text: "[Compressed section]" } as any],
    }
    const back = fromWire([summary], meta).messages
    assert.deepEqual(back.slice(0, 2), req.messages.slice(0, 2))
    assert.deepEqual(back[2], {
        role: "user",
        content: [{ type: "text", text: "[Compressed section]" }],
    })
    assert.deepEqual(back.slice(3), req.messages.slice(4))
})

test("an engine-added message never goes before the pinned one", () => {
    const req = hookedRequest()
    const { messages, meta } = toWire(req, SID)
    const nudge = {
        info: { id: "spliced", role: "user" } as any,
        parts: [{ type: "text", text: "nudge" } as any],
    }
    const back = fromWire([nudge, ...messages], meta).messages
    assert.deepEqual(back[0], req.messages[0])
})

test("a first message holding only tool results is not pinned", () => {
    const req: AnthropicRequest = {
        messages: [
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "x" }] },
            { role: "user", content: "next" },
        ],
    }
    const { messages } = toWire(req, SID)
    assert.deepEqual(
        messages.map((m) => m.info.id),
        ["claude:g1"],
    )
})

test("a dropped cache breakpoint is restored on the final message", () => {
    const req: AnthropicRequest = {
        messages: [
            { role: "user", content: "a" },
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
            },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "t1",
                        content: [{ type: "text", text: "huge body", cache_control: BREAKPOINT }],
                    },
                ],
            },
        ],
    }
    const { messages, meta } = toWire(req, SID)
    const toolPart = messages[0]!.parts.find((p) => p.type === "tool") as any
    toolPart.state.output = "[pruned]"
    const back = fromWire(messages, meta).messages
    const final = back[back.length - 1]!.content as Array<Record<string, unknown>>
    assert.equal(final[0]!.content, "[pruned]")
    assert.deepEqual(final[0]!.cache_control, BREAKPOINT)
})

test("text the engine adds to a tool-only turn goes after that turn's tool results", () => {
    const req: AnthropicRequest = {
        messages: [
            { role: "user", content: "go" },
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "t", signature: "sig" },
                    { type: "tool_use", id: "t1", name: "Read", input: {} },
                ],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "t1", content: "body" }],
            },
        ],
    }
    const { messages, meta } = toWire(req, SID)
    const assistant = messages[0]!
    assistant.parts.splice(1, 0, { type: "text", text: "NUDGE" } as any)
    const back = fromWire(messages, meta).messages
    assert.deepEqual(back[1], req.messages[1])
    assert.deepEqual(back[2]!.content, [
        { type: "tool_result", tool_use_id: "t1", content: "body" },
        { type: "text", text: "NUDGE" },
    ])
})
