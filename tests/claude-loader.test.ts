import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { register } from "node:module"

const testConfigHome = join(tmpdir(), `opencode-dcp-claude-loader-config-${process.pid}`)
process.env.XDG_DATA_HOME = join(tmpdir(), `opencode-dcp-claude-loader-${process.pid}`)
process.env.XDG_CONFIG_HOME = testConfigHome
mkdirSync(join(testConfigHome, "opencode"), { recursive: true })

register(
    "data:text/javascript," +
        encodeURIComponent(
            'export const resolve = (s, c, n) => n(s === "jsonc-parser/lib/esm/main.js" ? "jsonc-parser" : s, c)',
        ),
)

const { start, stop } = await import("../lib/claude/loader")

const FLAG = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"

function started(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    try {
        start(undefined, env)
    } finally {
        stop()
    }
    return env
}

test("start turns on function hooks so the compress mod loads with the loader", () => {
    assert.equal(started({})[FLAG], "1")
})

test("start treats an empty function-hooks value as unset", () => {
    assert.equal(started({ [FLAG]: "" })[FLAG], "1")
})

test("start keeps a function-hooks value the user set", () => {
    assert.equal(started({ [FLAG]: "0" })[FLAG], "0")
})

test("start leaves function hooks off when DCP is disabled", () => {
    writeFileSync(join(testConfigHome, "opencode", "dcp.jsonc"), '{ "enabled": false }')
    assert.equal(started({})[FLAG], undefined)
})

test("start wraps fetch once and stop restores it", () => {
    const original = globalThis.fetch
    try {
        start(undefined, {})
        const wrapped = globalThis.fetch
        assert.notEqual(wrapped, original)
        start(undefined, {})
        assert.equal(globalThis.fetch, wrapped)
    } finally {
        stop()
    }
    assert.equal(globalThis.fetch, original)
})

test("start stays out of the way while another DCP loader is active", () => {
    const original = globalThis.fetch
    const key = Symbol.for("dcp.claude.loader")
    const global = globalThis as { [key]?: string }
    global[key] = "arafays"
    try {
        start(undefined, {})
        assert.equal(globalThis.fetch, original)
    } finally {
        stop()
        delete global[key]
    }
})
