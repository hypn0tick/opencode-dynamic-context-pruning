import assert from "node:assert/strict"
import test from "node:test"

import { syncCompressionBlocks } from "../lib/messages"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"

const logger = new Logger(false)

function claudeMessages(): WithParts[] {
    const mk = (id: string, role: "user" | "assistant"): WithParts =>
        ({ info: { id, role, sessionID: "ses" }, parts: [] }) as unknown as WithParts
    return [mk("claude:g0", "user"), mk("claude:g1", "assistant")]
}

function seedBlock(state: SessionState, compressMessageId: string): number {
    const blockId = 1
    const ms = state.prune.messages
    ms.blocksById.set(blockId, {
        blockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 10,
        durationMs: 0,
        mode: "range",
        topic: "t",
        batchTopic: "t",
        startId: "@1@",
        endId: "@2@",
        anchorMessageId: "claude:g0",
        compressMessageId,
        compressCallId: "toolu_01ABC",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["claude:g0"],
        effectiveToolIds: [],
        createdAt: Date.now(),
    } as unknown as Parameters<typeof ms.blocksById.set>[1])
    return blockId
}

test("a block whose origin is a tool call id is deactivated", () => {
    const state = createSessionState("compact")
    const blockId = seedBlock(state, "toolu_01ABC")

    syncCompressionBlocks(state, logger, claudeMessages())

    const block = state.prune.messages.blocksById.get(blockId)!
    assert.equal(block.active, false)
    assert.equal(state.prune.messages.activeBlockIds.has(blockId), false)
})

test("a block whose origin is the issuing message stays active", () => {
    const state = createSessionState("compact")
    const blockId = seedBlock(state, "claude:g1")

    syncCompressionBlocks(state, logger, claudeMessages())

    const block = state.prune.messages.blocksById.get(blockId)!
    assert.equal(block.active, true)
    assert.equal(state.prune.messages.activeBlockIds.has(blockId), true)
})
