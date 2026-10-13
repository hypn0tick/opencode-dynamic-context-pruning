import { copyFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { defineConfig } from "tsup"

const require = createRequire(import.meta.url)

export default defineConfig([
    {
        entry: ["index.ts"],
        format: ["esm"],
        dts: false,
        // npm run build cleans dist first; cleaning here would race the loader build
        clean: false,
        sourcemap: true,
        noExternal: ["jsonc-parser"], // Bundle this to fix its broken ESM imports
    },
    {
        // The Claude Code preload: one self-contained file beside the tokenizer
        // wasm it reads from its own directory.
        entry: { "claude/claude-loader": "lib/claude/boot.ts" },
        format: ["esm"],
        platform: "node",
        dts: false,
        clean: false,
        sourcemap: false,
        noExternal: [/.*/],
        outExtension: () => ({ js: ".mjs" }),
        onSuccess: async () => {
            const lite = dirname(require.resolve("tiktoken/lite"))
            copyFileSync(join(lite, "tiktoken_bg.wasm"), join("dist", "claude", "tiktoken_bg.wasm"))
        },
    },
])
