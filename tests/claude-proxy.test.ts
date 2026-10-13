import assert from "node:assert/strict"
import { test } from "node:test"

import type { ClaudeAdapter, Usage } from "../lib/claude/host"
import {
    contextFromHeaders,
    createSseTap,
    readUsageLine,
    renameToolUseLine,
    shouldHandle,
    transformBody,
} from "../lib/claude/proxy"

function fakeAdapter(apply: (r: any) => unknown, errors: unknown[] = []): ClaudeAdapter {
    return {
        apply: async (r: unknown) => apply(r),
        reportError: (error: unknown) => errors.push(error),
    } as unknown as ClaudeAdapter
}

test("contextFromHeaders reads session, class, and the 1m window beta", () => {
    const ctx = contextFromHeaders(
        new Headers({
            "x-claude-code-session-id": "ses_1",
            "x-claude-code-request-class": "chat",
            "anthropic-beta": "foo,context-1m-2025",
        }),
    )
    assert.equal(ctx.sessionId, "ses_1")
    assert.equal(ctx.requestClass, "chat")
    assert.equal(ctx.window, 1_000_000)
})

test("contextFromHeaders leaves the window unset without the beta", () => {
    const ctx = contextFromHeaders(new Headers({ "x-claude-code-session-id": "ses_1" }))
    assert.equal(ctx.window, undefined)
    assert.equal(ctx.requestClass, undefined)
})

test("shouldHandle matches the message endpoints only", () => {
    assert.equal(shouldHandle("https://api.anthropic.com/v1/messages"), true)
    assert.equal(shouldHandle("https://api.anthropic.com/v1/messages/count_tokens"), true)
    assert.equal(shouldHandle("https://api.anthropic.com/v1/models"), false)
})

test("transformBody passes through when unkeyed, unparseable, or message-less", async () => {
    const adapter = fakeAdapter((r) => r)
    assert.equal((await transformBody("{}", { sessionId: "" }, adapter)).body, "{}")
    assert.equal((await transformBody("not json", { sessionId: "s" }, adapter)).body, "not json")
    const noMessages = JSON.stringify({ foo: 1 })
    assert.equal((await transformBody(noMessages, { sessionId: "s" }, adapter)).body, noMessages)
})

test("transformBody returns the adapter's rewritten body", async () => {
    const adapter = fakeAdapter((r) => ({ ...r, tools: ["x"] }))
    const body = JSON.stringify({ messages: [] })
    const out = await transformBody(body, { sessionId: "s" }, adapter)
    assert.deepEqual(JSON.parse(out.body), { messages: [], tools: ["x"] })
    assert.equal(out.rename, undefined)
})

test("transformBody sends the original body and reports the error when apply throws", async () => {
    const errors: unknown[] = []
    const adapter = fakeAdapter(() => {
        throw new Error("engine bug")
    }, errors)
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    const out = await transformBody(body, { sessionId: "s" }, adapter)
    assert.equal(out.body, body)
    assert.equal(errors.length, 1)
})

test("transformBody renames the response only for a request offering the mod's tool", async () => {
    const adapter = fakeAdapter((r) => ({ ...r }))
    const withMod = JSON.stringify({ messages: [], tools: [{ name: "mcp__dcp__compress" }] })
    assert.deepEqual((await transformBody(withMod, { sessionId: "s" }, adapter)).rename, {
        from: "compress",
        to: "mcp__dcp__compress",
    })
    const other = JSON.stringify({ messages: [], tools: [{ name: "mcp__zip__compress" }] })
    assert.equal((await transformBody(other, { sessionId: "s" }, adapter)).rename, undefined)
})

test("renameToolUseLine renames only a matching tool_use start line", () => {
    const line =
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"compress"}}'
    const out = renameToolUseLine(line, "compress", "mcp__dcp__compress")
    assert.ok(out.includes('"name":"mcp__dcp__compress"'))
    assert.equal(renameToolUseLine("event: ping", "compress", "x"), "event: ping")
})

test("the SSE tap renames across chunk boundaries", () => {
    const tap = createSseTap({ rename: { from: "compress", to: "mcp__dcp__compress" } })
    const line =
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"compress"}}\n'
    let out = tap.transform(line.slice(0, 20))
    out += tap.transform(line.slice(20))
    out += tap.flush()
    assert.ok(out.includes('"name":"mcp__dcp__compress"'))
})

const START =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":170000,"cache_creation_input_tokens":2000,"output_tokens":1}}}'
const DELTA = 'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":250}}'

test("readUsageLine folds message_start and message_delta usage", () => {
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    assert.equal(readUsageLine(START, usage), true)
    assert.equal(readUsageLine(DELTA, usage), true)
    assert.equal(readUsageLine('data: {"type":"ping"}', usage), false)
    assert.deepEqual(usage, { input: 3, output: 250, cacheRead: 170000, cacheWrite: 2000 })
})

test("the SSE tap reports usage once the stream ends and passes every byte through", () => {
    const seen: Usage[] = []
    const tap = createSseTap({ onUsage: (usage) => seen.push(usage) })
    const stream = `${START}\n\n${DELTA}\n\n`
    const out = tap.transform(stream.slice(0, 40)) + tap.transform(stream.slice(40)) + tap.flush()
    assert.equal(out, stream)
    assert.deepEqual(seen, [{ input: 3, output: 250, cacheRead: 170000, cacheWrite: 2000 }])
})

test("the SSE tap reports usage at message_stop, even if the stream is never flushed", () => {
    const seen: Usage[] = []
    const tap = createSseTap({ onUsage: (usage) => seen.push(usage) })
    tap.transform(`${START}\n\n${DELTA}\n\ndata: {"type":"message_stop"}\n\n`)
    assert.equal(seen.length, 1)
    tap.flush()
    assert.equal(seen.length, 1)
})
