import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { register } from "node:module"

const testDataHome = join(tmpdir(), `opencode-dcp-claude-apply-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-claude-apply-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

register(
    "data:text/javascript," +
        encodeURIComponent(
            'export const resolve = (s, c, n) => n(s === "jsonc-parser/lib/esm/main.js" ? "jsonc-parser" : s, c)',
        ),
)

const { ClaudeAdapter } = await import("../lib/claude/host")
const { countTokens } = await import("../lib/token-utils")
type AnthropicRequest = import("../lib/claude/wire").AnthropicRequest
type AnthropicMessage = import("../lib/claude/wire").AnthropicMessage

const BULK = Array.from(
    { length: 400 },
    (_, i) => `line ${i}: const value${i} = compute(${i})`,
).join("\n")

function baseMessages(): AnthropicMessage[] {
    return [
        { role: "user", content: "Read src/big.ts and tell me what it does." },
        {
            role: "assistant",
            content: [
                { type: "text", text: "Reading the file." },
                {
                    type: "tool_use",
                    id: "toolu_read1",
                    name: "Read",
                    input: { path: "src/big.ts" },
                },
            ],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_read1", content: BULK }],
        },
        {
            role: "assistant",
            content: [
                { type: "text", text: "It computes 400 values." },
                { type: "tool_use", id: "toolu_read2", name: "Read", input: { path: "src/b2.ts" } },
            ],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_read2", content: BULK }],
        },
        { role: "assistant", content: [{ type: "text", text: "Both files compute values." }] },
        { role: "user", content: "Now compress the exploration." },
    ]
}

const MOD_TOOL = {
    name: "mcp__dcp__compress",
    description:
        "Unavailable: DCP's proxy, which performs compression, is not handling this conversation. Do not call this tool.",
    input_schema: { type: "object" },
}
const MOD_RESULT =
    "Handed to DCP. Its proxy replaces this text with the compression result before the model reads it; a model that receives this text instead must treat the request as not applied: DCP is not active here and nothing was compressed."

function request(messages: AnthropicMessage[], withMod = false): AnthropicRequest {
    return {
        model: "claude-haiku-5-5",
        system: [{ type: "text", text: "You are Claude Code." }],
        messages,
        tools: [
            { name: "Read", description: "read", input_schema: { type: "object" } },
            ...(withMod ? [MOD_TOOL] : []),
        ],
    }
}

function wireTokens(req: AnthropicRequest): number {
    return countTokens(JSON.stringify(req.messages))
}

function refsIn(message: AnthropicMessage): string[] {
    return [...JSON.stringify(message.content).matchAll(/@(\d+)@/g)].map((m) => `@${m[1]}@`)
}

function compressTurn(toolName: string, startId: string, endId: string, result: string) {
    const call: AnthropicMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "toolu_compress1",
                name: toolName,
                input: {
                    topic: "File exploration",
                    content: [
                        {
                            startId,
                            endId,
                            summary: "Read src/big.ts and src/b2.ts; both compute 400 values.",
                        },
                    ],
                },
            },
        ],
    }
    const answer: AnthropicMessage = {
        role: "user",
        content: [
            {
                type: "tool_result",
                tool_use_id: "toolu_compress1",
                content: result,
                is_error: result.includes("tool_use_error"),
            },
        ],
    }
    return [call, answer]
}

async function runSession(toolName: string, result: string, sessionId: string) {
    const adapter = new ClaudeAdapter()
    const ctx = { sessionId, requestClass: "main" }
    const withMod = toolName !== "compress"
    const turn1 = baseMessages()
    const out1 = await adapter.apply(request(turn1, withMod), ctx)

    const refs = out1.messages.flatMap(refsIn)
    assert.ok(refs.length >= 2, `adapter tagged no message refs: ${JSON.stringify(refs)}`)
    const startId = refs[0]!
    const endId = refs[refs.length - 2]!

    const turn2 = [...turn1, ...compressTurn(toolName, startId, endId, result)]
    const in2 = request(turn2, withMod)
    const out2 = await adapter.apply(in2, ctx)

    const turn3 = [
        ...turn2,
        { role: "assistant", content: [{ type: "text", text: "Compressed." }] },
        { role: "user", content: "Continue." },
    ] as AnthropicMessage[]
    const in3 = request(turn3, withMod)
    const out3 = await adapter.apply(in3, ctx)
    const restarted = await new ClaudeAdapter().apply(in3, ctx)
    return { in2, out2, in3, out3, restarted }
}

const BREAKPOINT = { type: "ephemeral", ttl: "1h" }

function reminder(marked: boolean): AnthropicMessage {
    const text = "<total_tokens>9</total_tokens>"
    return marked
        ? { role: "system", content: [{ type: "text", text, cache_control: BREAKPOINT }] }
        : { role: "system", content: text }
}

function withHooks(messages: AnthropicMessage[]): AnthropicMessage[] {
    return [
        messages[0]!,
        { role: "system", content: "SessionStart hook additional context: be terse." },
        ...messages.slice(1),
        reminder(true),
    ]
}

function nextTurn(previous: AnthropicMessage[], added: AnthropicMessage[]): AnthropicMessage[] {
    return [...previous.slice(0, -1), reminder(false), ...added, reminder(true)]
}

function unmarked(message: AnthropicMessage): string {
    const content =
        typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content
    return JSON.stringify({ ...message, content }, (key, value) =>
        key === "cache_control" ? undefined : value,
    )
}

function markerIndexes(messages: AnthropicMessage[]): number[] {
    return messages.flatMap((m, i) =>
        JSON.stringify(m.content).includes("cache_control") ? [i] : [],
    )
}

test("apply() keeps hook system messages and the message cache breakpoint", async () => {
    const adapter = new ClaudeAdapter()
    const ctx = { sessionId: "ses_cache", requestClass: "main" }
    const turn1 = withHooks(baseMessages())
    const out1 = await adapter.apply(request(turn1), ctx)

    assert.equal(out1.messages.filter((m) => m.role === "system").length, 2)
    assert.deepEqual(markerIndexes(out1.messages), [out1.messages.length - 1])
    assert.deepEqual(out1.messages[out1.messages.length - 1], turn1[turn1.length - 1])

    const turn2 = nextTurn(turn1, [
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: "Thanks." },
    ])
    const out2 = await adapter.apply(request(turn2), ctx)

    assert.deepEqual(markerIndexes(out2.messages), [out2.messages.length - 1])
    const cached = markerIndexes(out1.messages)[0]!
    for (let i = 0; i <= cached; i++)
        assert.equal(
            unmarked(out2.messages[i]!),
            unmarked(out1.messages[i]!),
            `request 2 changes cached prefix message ${i}`,
        )
})

test("apply() keeps the cache breakpoint after a compress", async () => {
    const adapter = new ClaudeAdapter()
    const ctx = { sessionId: "ses_cache_compress", requestClass: "main" }
    const turn1 = withHooks(baseMessages())
    const out1 = await adapter.apply(request(turn1), ctx)
    const refs = out1.messages.flatMap(refsIn)
    const turn2 = nextTurn(
        turn1,
        compressTurn(
            "compress",
            refs[0]!,
            refs[refs.length - 2]!,
            "<tool_use_error>Error: No such tool available: compress</tool_use_error>",
        ),
    )
    const out2 = await adapter.apply(request(turn2), ctx)

    assert.ok(!JSON.stringify(out2.messages).includes("line 399: const value399"))
    assert.deepEqual(markerIndexes(out2.messages), [out2.messages.length - 1])
    assert.deepEqual(out2.messages[out2.messages.length - 1], turn2[turn2.length - 1])
    assert.ok(JSON.stringify(out2.messages).includes("SessionStart hook additional context"))
})

test("apply() never tags or compresses the first user message", async () => {
    const adapter = new ClaudeAdapter()
    const ctx = { sessionId: "ses_pinned", requestClass: "main" }
    const turn1 = withHooks(baseMessages())
    const out1 = await adapter.apply(request(turn1), ctx)
    assert.deepEqual(out1.messages[0], turn1[0])

    const refs = out1.messages.flatMap(refsIn)
    const turn2 = nextTurn(
        turn1,
        compressTurn(
            "compress",
            refs[0]!,
            refs[refs.length - 2]!,
            "<tool_use_error>Error: No such tool available: compress</tool_use_error>",
        ),
    )
    const out2 = await adapter.apply(request(turn2), ctx)
    assert.ok(!JSON.stringify(out2.messages).includes("line 399: const value399"))
    assert.deepEqual(out2.messages.slice(0, 2), turn1.slice(0, 2))
    assert.deepEqual(out2.messages.slice(0, 2), out1.messages.slice(0, 2))
})

for (const [label, toolName, result] of [
    [
        "bare compress answered by the harness no-such-tool error",
        "compress",
        "<tool_use_error>Error: No such tool available: compress</tool_use_error>",
    ],
    ["mod-routed mcp__dcp__compress result", "mcp__dcp__compress", MOD_RESULT],
] as const) {
    test(`apply() shrinks the outbound transcript after a ${label}`, async () => {
        const { in2, out2, in3, out3, restarted } = await runSession(
            toolName,
            result,
            `ses_${toolName}`,
        )
        const before2 = wireTokens(in2)
        const after2 = wireTokens(out2)
        const before3 = wireTokens(in3)

        assert.ok(
            after2 < before2 / 3,
            `request after compress not pruned: ${before2} -> ${after2}`,
        )
        assert.ok(
            wireTokens(out3) < before3 / 3,
            `compression did not persist: ${before3} -> ${wireTokens(out3)}`,
        )
        assert.ok(
            wireTokens(restarted) < before3 / 3,
            `compression lost on a fresh adapter: ${before3} -> ${wireTokens(restarted)}`,
        )
        for (const out of [out3, restarted]) {
            const text = JSON.stringify(out.messages)
            assert.ok(!text.includes("line 399: const value399"))
            assert.ok(text.includes("both compute 400 values"))
        }
        for (const out of [out2, out3, restarted]) {
            const text = JSON.stringify(out.messages)
            assert.ok(!text.includes("No such tool available"), "harness error reached the model")
            assert.ok(!text.includes("nothing was compressed"), "mod fallback reached the model")
            assert.ok(
                !JSON.stringify(out.tools).includes("Unavailable:"),
                "mod definition reached the model",
            )
        }
    })
}

test("apply() sizes context from the API's reported usage, cache included", async () => {
    const nudged = (out: AnthropicRequest) =>
        JSON.stringify(out.messages).includes("MAX CONTEXT LIMIT REACHED")
    const quiet = new ClaudeAdapter()
    assert.equal(nudged(await quiet.apply(request(baseMessages()), { sessionId: "ses_u0" })), false)

    const reported = new ClaudeAdapter()
    reported.setUsage("ses_u1", { input: 3, output: 200, cacheRead: 150_000, cacheWrite: 0 })
    assert.equal(
        nudged(await reported.apply(request(baseMessages()), { sessionId: "ses_u1" })),
        true,
    )
})
