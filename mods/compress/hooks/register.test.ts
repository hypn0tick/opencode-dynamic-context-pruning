import { expect, mock, test } from "claude-code/testing"

const WIN = { OS: "Windows_NT", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }
const TOKEN = "--preload=C:/Users/u/AppData/Local/claude-dcp-tarquinen/claude-loader.mjs"

type Stage = {
    env: Record<string, string>
    exists?: (path: string) => boolean
    staged?: boolean
    userEnv?: string
    kernel?: string
}

function stub(on: Parameters<Parameters<typeof test>[1]>[1], stage: Stage) {
    const runs: string[] = []
    const statuses: string[] = []
    const writes: string[] = []
    mock.env(on, stage.env)
    on("tool.register", () => ({ value: undefined }))
    on("session.start", () => ({ cwd: "/work" }))
    on("fs.exists", (_$, e) => {
        const path = String((e as { path?: unknown }).path ?? JSON.stringify(e))
        return { value: (stage.exists ?? (() => true))(path) }
    })
    on("fs.read", (_$, e) => {
        const packaged = /[\\/]dist[\\/]/.test(JSON.stringify(e))
        return { value: packaged && !stage.staged ? "loader v2" : "loader v1" }
    })
    on("fs.write", (_$, e) => {
        writes.push(JSON.stringify(e))
        return { value: undefined }
    })
    on("process.run", (_$, e) => {
        const call = JSON.stringify(e)
        runs.push(call)
        const stdout = call.includes("GetEnvironmentVariable")
            ? (stage.userEnv ?? "")
            : call.includes("uname")
              ? (stage.kernel ?? "Linux")
              : ""
        return { value: { exitCode: 0, stdout, stderr: "" } }
    })
    on("ui.status", (_$, e) => {
        statuses.push(JSON.stringify(e))
        return { value: undefined }
    })
    return { runs, statuses, writes }
}

const start = { surface: "terminal", isInteractive: true, cwd: "/work" }

test("answers a compress call with text that says nothing was compressed unless the proxy replaces it", async ($) => {
    const result = await $.tool.call({ tool: "mcp__dcp__compress", topic: "demo", content: [] })
    expect(JSON.stringify(result)).toContain("nothing was compressed")
})

test("a first start stages the loader and adds its preload to User BUN_OPTIONS", async ($, on) => {
    const seen = stub(on, {
        env: WIN,
        exists: (p) => !p.includes("active.json"),
        userEnv: "--smol",
    })
    await $.session.start(start)
    expect(seen.runs.some((r) => r.includes("Copy-Item") && r.includes("tiktoken_bg.wasm"))).toBe(
        true,
    )
    expect(seen.writes.join()).toContain("pluginRoot")
    const set = seen.runs.find((r) => r.includes("SetEnvironmentVariable"))
    expect(set).toContain(`--smol ${TOKEN}`)
    expect(seen.statuses.join()).toContain("restart Claude Code")
})

test("a staged, active loader spawns nothing and stays quiet", async ($, on) => {
    const seen = stub(on, { env: { ...WIN, BUN_OPTIONS: TOKEN }, staged: true })
    await $.session.start(start)
    expect(seen.runs).toEqual([])
    expect(seen.statuses).toEqual([])
})

test("an update restages even when it installs to the same plugin dir", async ($, on) => {
    const seen = stub(on, { env: { ...WIN, BUN_OPTIONS: TOKEN } })
    await $.session.start(start)
    expect(seen.runs.some((r) => r.includes("Copy-Item"))).toBe(true)
    expect(seen.statuses).toEqual([])
})

test("dry run stages but never changes BUN_OPTIONS", async ($, on) => {
    const seen = stub(on, {
        env: { ...WIN, CLAUDE_DCP_DRY: "1" },
        exists: (p) => !p.includes("active.json"),
    })
    await $.session.start(start)
    expect(seen.runs.some((r) => r.includes("SetEnvironmentVariable"))).toBe(false)
    expect(seen.statuses.join()).toContain("DCP DRY")
})

test("a package without a built loader says DCP is not active", async ($, on) => {
    const seen = stub(on, { env: WIN, exists: () => false })
    await $.session.start(start)
    expect(seen.runs).toEqual([])
    expect(seen.statuses.join()).toContain("no built loader")
})

const POSIX_TOKEN = "--preload=/home/u/.local/share/claude-dcp-tarquinen/claude-loader.mjs"

test("on Linux it stages with cp and writes an environment.d file", async ($, on) => {
    const seen = stub(on, { env: { HOME: "/home/u" }, exists: (p) => !p.includes("active.json") })
    await $.session.start(start)
    expect(seen.runs.some((r) => r.includes("cp -f"))).toBe(true)
    const file = seen.writes.find((w) => w.includes("60-claude-dcp-tarquinen.conf"))
    expect(file).toMatch(/home.+u.+\.config.+environment\.d/)
    expect(file).toContain(
        JSON.stringify(`"\${BUN_OPTIONS:+$BUN_OPTIONS }${POSIX_TOKEN}"`).slice(1, -1),
    )
    expect(seen.statuses.join()).toContain("log out and back in")
})

test("on macOS it sets launchd's BUN_OPTIONS and writes a login agent", async ($, on) => {
    const seen = stub(on, {
        env: { HOME: "/Users/u" },
        exists: (p) => !p.includes("active.json"),
        kernel: "Darwin",
    })
    await $.session.start(start)
    const plist = seen.writes.find((w) => w.includes("com.dcp.claude-tarquinen.plist"))
    expect(plist).toMatch(/Users.+u.+Library.+LaunchAgents/)
    expect(plist).toContain("RunAtLoad")
    expect(seen.runs.some((r) => r.includes("launchctl setenv BUN_OPTIONS"))).toBe(true)
    expect(seen.statuses.join()).toContain("quit and reopen Claude Code")
})
