import { rmSync } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"
import { execFileSync } from "node:child_process"

// Removes the --preload token from where the compress mod persisted it, then the
// staged loader dir. A --preload naming a missing file stops Claude Code (and any
// Bun program) from starting, so the dir goes only once no environment this
// script can see still carries the token; otherwise it says to run it again.
const IS_WIN = platform() === "win32"
const IS_MAC = platform() === "darwin"

function stableDir() {
    const dataHome =
        process.env.XDG_DATA_HOME ||
        (IS_WIN
            ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
            : join(homedir(), ".local", "share"))
    return join(dataHome, "claude-dcp-tarquinen")
}

const words = (value) => (value ?? "").split(/\s+/).filter((entry) => entry.length > 0)
const psQuote = (value) => `'${value.replace(/'/g, "''")}'`

const dir = stableDir()
const token = `--preload=${join(dir, "claude-loader.mjs").replace(/\\/g, "/")}`

// Returns true when the persisted setting is free of the token.
function removePersisted() {
    if (IS_WIN) {
        const read = () =>
            execFileSync(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    "[Environment]::GetEnvironmentVariable('BUN_OPTIONS','User')",
                ],
                { encoding: "utf8" },
            )
        const parts = words(read())
        if (parts.includes(token)) {
            const next = parts.filter((entry) => entry !== token).join(" ")
            execFileSync("powershell", [
                "-NoProfile",
                "-Command",
                `[Environment]::SetEnvironmentVariable('BUN_OPTIONS', ${next ? psQuote(next) : "$null"}, 'User')`,
            ])
            console.log("Removed the DCP preload from User BUN_OPTIONS.")
        }
        return !words(read()).includes(token)
    }
    if (IS_MAC) {
        rmSync(join(homedir(), "Library", "LaunchAgents", "com.dcp.claude-tarquinen.plist"), {
            force: true,
        })
        const parts = words(
            execFileSync("launchctl", ["getenv", "BUN_OPTIONS"], { encoding: "utf8" }),
        )
        if (parts.includes(token)) {
            const next = parts.filter((entry) => entry !== token).join(" ")
            if (next) execFileSync("launchctl", ["setenv", "BUN_OPTIONS", next])
            else execFileSync("launchctl", ["unsetenv", "BUN_OPTIONS"])
            console.log("Removed the DCP preload from launchd's BUN_OPTIONS and its login agent.")
        }
        return true
    }
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    rmSync(join(configHome, "environment.d", "60-claude-dcp-tarquinen.conf"), { force: true })
    console.log("Removed the DCP environment.d file; it stops applying at your next login.")
    return true
}

let persistedClear = false
try {
    persistedClear = removePersisted()
} catch (error) {
    console.error(
        "Could not update BUN_OPTIONS:",
        error instanceof Error ? error.message : String(error),
    )
}

if (persistedClear && !words(process.env.BUN_OPTIONS).includes(token)) {
    try {
        rmSync(dir, { recursive: true, force: true })
        console.log("Removed the staged loader dir:", dir)
    } catch {}
    console.log("Restart Claude Code for the change to take effect.")
} else {
    if (!IS_WIN && !IS_MAC)
        console.log(`Remove ${token} from BUN_OPTIONS in your shell profile if you added it there.`)
    console.log(
        `The staged loader stays in ${dir} while BUN_OPTIONS still names it. Open a new terminal (on Linux, log out and back in), then run this script again to remove it.`,
    )
}
