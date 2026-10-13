import { ClaudeAdapter } from "./host"
import { installFetchInterception, type RequestObserver } from "./proxy"

const FUNCTION_HOOKS = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"
// Shared by every DCP Claude Code loader (either engine), so only the first one
// in a process wraps fetch; two would transform each request twice.
export const ACTIVE = Symbol.for("dcp.claude.loader")

let uninstall: (() => void) | undefined

// Idempotent, and a no-op while another DCP loader is active in this process.
// Also turns on function hooks for builds that still gate mods, unless the user
// set the variable.
export function start(observe?: RequestObserver, env: NodeJS.ProcessEnv = process.env): void {
    const global = globalThis as { [ACTIVE]?: string }
    if (uninstall || global[ACTIVE] !== undefined) return
    const adapter = new ClaudeAdapter()
    uninstall = installFetchInterception(adapter, observe)
    global[ACTIVE] = "tarquinen"
    if (adapter.enabled && !env[FUNCTION_HOOKS]) env[FUNCTION_HOOKS] = "1"
}

export function stop(): void {
    if (!uninstall) return
    uninstall()
    uninstall = undefined
    delete (globalThis as { [ACTIVE]?: string })[ACTIVE]
}
