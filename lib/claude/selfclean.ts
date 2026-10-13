import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"
import { execFileSync } from "node:child_process"
import { isMainThread } from "node:worker_threads"

// Keep in sync with mods/compress/hooks/register.ts.
export const PLUGIN_ID = "dcp@claude-dcp-tarquinen"
const LINUX_ENV_FILE = "60-claude-dcp-tarquinen.conf"
const MAC_AGENT = "com.dcp.claude-tarquinen"
const IS_WIN = platform() === "win32"
const IS_MAC = platform() === "darwin"

export function stableDir(): string {
    const dataHome =
        process.env.XDG_DATA_HOME ||
        (IS_WIN
            ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
            : join(homedir(), ".local", "share"))
    return join(dataHome, "claude-dcp-tarquinen")
}

function loaderToken(): string {
    return `--preload=${join(stableDir(), "claude-loader.mjs").replace(/\\/g, "/")}`
}

// A PowerShell single-quoted literal.
export function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

// A leftover BUN_OPTIONS token must not affect plain `bun` runs or workers.
function isClaudeMain(): boolean {
    try {
        const bun = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun
        if (!bun?.isStandaloneExecutable || !isMainThread) return false
        return /(^|[\\/])claude(\.exe)?$/i.test(process.execPath || "")
    } catch {
        return false
    }
}

export type Enabled = "yes" | "no" | "absent" | "error"

// Uninstall removes the enabledPlugins key and disable sets it false. Unreadable
// or missing settings give "error".
export function enabledInSettings(
    configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    cwd = process.cwd(),
): Enabled {
    const files = [
        join(configDir, "settings.json"),
        join(cwd, ".claude", "settings.json"),
        join(cwd, ".claude", "settings.local.json"),
    ]
    let anyReadable = false
    let sawKey = false
    for (const file of files) {
        if (!existsSync(file)) continue
        let map: Record<string, boolean> | undefined
        try {
            map = (
                JSON.parse(readFileSync(file, "utf8")) as {
                    enabledPlugins?: Record<string, boolean>
                }
            ).enabledPlugins
        } catch {
            return "error"
        }
        anyReadable = true
        if (map && PLUGIN_ID in map) {
            sawKey = true
            if (map[PLUGIN_ID] === true) return "yes"
        }
    }
    if (!anyReadable) return "error"
    return sawKey ? "no" : "absent"
}

// Whether Claude Code still has the plugin installed in any scope. A project
// install is invisible from other projects' settings, so only this registry
// tells an uninstall apart; an unreadable registry counts as installed.
export function installedAnywhere(
    configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): boolean {
    try {
        const registry = JSON.parse(
            readFileSync(join(configDir, "plugins", "installed_plugins.json"), "utf8"),
        ) as { plugins?: Record<string, unknown> }
        const entry = registry.plugins?.[PLUGIN_ID]
        return Array.isArray(entry) ? entry.length > 0 : entry !== undefined
    } catch {
        return true
    }
}

const dry = () => process.env.CLAUDE_DCP_SELFCLEAN_DRY === "1"

function recordDry(line: string): void {
    writeFileSync(join(stableDir(), "selfclean-dry.out"), `${line}\n`, { flag: "a" })
}

// Removes this plugin's --preload token from where the mod persisted it. The
// staged loader is left in place so the token never points at a missing file.
export function stripOwnToken(): void {
    const token = loaderToken()
    try {
        if (IS_WIN) {
            const current = execFileSync(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    "[Environment]::GetEnvironmentVariable('BUN_OPTIONS','User')",
                ],
                { encoding: "utf8" },
            ).trim()
            const parts = current.split(/\s+/).filter((entry) => entry.length > 0)
            if (!parts.includes(token)) return
            const next = parts.filter((entry) => entry !== token).join(" ")
            if (dry()) return recordDry(`would set BUN_OPTIONS=[${next}]`)
            execFileSync("powershell", [
                "-NoProfile",
                "-Command",
                `[Environment]::SetEnvironmentVariable('BUN_OPTIONS', ${next ? psQuote(next) : "$null"}, 'User')`,
            ])
        } else if (IS_MAC) {
            const agent = join(homedir(), "Library", "LaunchAgents", `${MAC_AGENT}.plist`)
            const current = execFileSync("launchctl", ["getenv", "BUN_OPTIONS"], {
                encoding: "utf8",
            }).trim()
            const parts = current.split(/\s+/).filter((entry) => entry.length > 0)
            const next = parts.filter((entry) => entry !== token).join(" ")
            if (dry())
                return recordDry(`would remove ${agent} and set launchd BUN_OPTIONS=[${next}]`)
            rmSync(agent, { force: true })
            if (!parts.includes(token)) return
            if (next) execFileSync("launchctl", ["setenv", "BUN_OPTIONS", next])
            else execFileSync("launchctl", ["unsetenv", "BUN_OPTIONS"])
        } else {
            const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
            const file = join(configHome, "environment.d", LINUX_ENV_FILE)
            if (dry()) return recordDry(`would remove ${file}`)
            rmSync(file, { force: true })
        }
    } catch {}
}

// Runs DCP where the plugin is enabled. Strips the token only once the plugin is
// uninstalled everywhere; disabled or absent in this project just skips.
export function guard(): "start" | "skip" {
    try {
        if (!isClaudeMain()) return "skip"
        const enabled = enabledInSettings()
        if (enabled === "yes" || enabled === "error") return "start"
        if (!installedAnywhere()) stripOwnToken()
        return "skip"
    } catch {
        return "start"
    }
}
