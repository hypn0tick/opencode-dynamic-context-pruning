import assert from "node:assert/strict"
import { test } from "node:test"

import {
    compressWireDef,
    findCompressCalls,
    offeredCompressName,
    rewriteCompressResult,
    rewriteOfferedCompressDef,
} from "../lib/claude/compress-router"

function assistant(parts: unknown[]): any {
    return { info: { role: "assistant" }, parts }
}

test("findCompressCalls matches bare and namespaced compress tool parts only", () => {
    const messages = [
        assistant([
            { type: "tool", tool: "compress", callID: "c1", state: { input: { topic: "a" } } },
            { type: "tool", tool: "Read", callID: "r1", state: { input: {} } },
        ]),
        assistant([
            { type: "tool", tool: "mcp__dcp__compress", callID: "c2", state: { input: {} } },
        ]),
        {
            info: { role: "user" },
            parts: [{ type: "tool", tool: "compress", callID: "c3" }],
        } as any,
    ]
    const calls = findCompressCalls(messages)
    assert.deepEqual(
        calls.map((c) => c.id),
        ["c1", "c2"],
    )
    assert.deepEqual(calls[0]!.input, { topic: "a" })
    assert.deepEqual(calls[1]!.input, {})
})

test("rewriteCompressResult completes the matching tool part output", () => {
    const messages = [
        assistant([{ type: "tool", tool: "compress", callID: "c1", state: { input: {} } }]),
    ]
    rewriteCompressResult(messages, "c1", "done")
    const part = messages[0]!.parts[0] as any
    assert.equal(part.state.status, "completed")
    assert.equal(part.state.output, "done")
})

test("offeredCompressName finds a compress tool by name", () => {
    assert.equal(offeredCompressName([{ name: "Read" }, { name: "compress" }]), "compress")
    assert.equal(offeredCompressName([{ name: "mcp__dcp__compress" }]), "mcp__dcp__compress")
    assert.equal(offeredCompressName([{ name: "Read" }]), undefined)
    assert.equal(offeredCompressName("nope"), undefined)
})

test("rewriteOfferedCompressDef canonicalizes the compress entry only", () => {
    const tools = [
        { name: "Read", description: "r", input_schema: {} },
        { name: "mcp__dcp__compress", description: "old", input_schema: { type: "old" } },
    ]
    const out = rewriteOfferedCompressDef(tools, "new desc", { type: "object" }) as any[]
    assert.deepEqual(out[0], tools[0])
    assert.equal(out[1].name, "compress")
    assert.equal(out[1].description, "new desc")
    assert.deepEqual(out[1].input_schema, { type: "object" })
})

test("compressWireDef builds the bare compress definition", () => {
    const def = compressWireDef("desc", { type: "object" })
    assert.deepEqual(def, {
        name: "compress",
        description: "desc",
        input_schema: { type: "object" },
    })
})

test("another server's *__compress tool is not treated as DCP's", () => {
    const tools = [{ name: "mcp__zip__compress", description: "zip", input_schema: {} }]
    assert.equal(offeredCompressName(tools), undefined)
    assert.deepEqual(rewriteOfferedCompressDef(tools, "d", {}), tools)
    const calls = findCompressCalls([
        assistant([{ type: "tool", tool: "mcp__zip__compress", callID: "z1", state: {} }]),
    ])
    assert.deepEqual(calls, [])
})
