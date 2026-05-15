# Compaction Override — Corrected Research & Design

## Goal

Integrate semantic memory into OpenCode's compaction lifecycle so that recent
memory chunks are available to the main agent after compaction.

---

## How Compaction Actually Works

### The Two Agents

There are TWO distinct LLM calls in play, and conflating them caused the errors
in the previous version of this document.

#### 1. The Compaction Agent (separate LLM call)

Spawned at `compaction.ts:391-394` when `/compact` is triggered:

```typescript
const agent = yield* agents.get("compaction")
// agent = { name: "compaction", prompt: PROMPT_COMPACTION, tools: {...} }
```

- System prompt: `compaction.txt` (static file)
- Tools: `{}` (none — all tools denied)
- Model: same as user's model (no model override on compaction agent)
- Input: HEAD messages (everything before the retained tail) + `buildPrompt()`
  output as a final user message
- Output: a summary assistant message stored in the DB with `mode: "compaction"`,
  `summary: true`, `agent: "compaction"`

#### 2. The Main Agent (me — the normal build agent)

Runs in the agent loop at `prompt.ts:1719+`. After compaction completes, the
loop continues normally:

```typescript
// prompt.ts:1698-1708
if (task?.type === "compaction") {
  yield* compaction.process({ ... })
  if (result === "stop") break
  continue   // ← goes back to top of loop
}
```

On the NEXT iteration (lines 1770-1832):

```typescript
const tools = yield* resolveTools({ agent, session, model, ... })
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),                              // available skills
  sys.environment(model),                          // model name, cwd, git, date
  instruction.system().pipe(Effect.orDie),          // AGENTS.md instructions
  MessageV2.toModelMessagesEffect(msgs, model),    // filtered conversation
])
const system = [...env, ...instructions, ...(skills ? [skills] : [])]

yield* handle.process({
  user: lastUser,
  agent,              // the BUILD agent
  system,             // fresh system prompt
  messages: [...modelMsgs, ...],
  tools,              // fresh tools
  model,
})
```

### What `filterCompacted()` Does

`filterCompacted()` at `message-v2.ts:1013-1063` reorders messages for the main
agent's view. It does NOT delete any messages — they all remain in the database.

The output order is:

```
[compaction-user (marker), summary-assistant, ...tail messages..., ...new messages...]
```

The old messages (before the tail) are placed AFTER the summary in the array.
They're effectively invisible because they exceed the model's context window,
but they're not gone.

### Key Insight

Compaction **only changes the message ordering**. It does NOT affect:
- The system prompt (reconstructed fresh every turn)
- Tool definitions (resolved fresh every turn)
- Agent identity (build agent, not compaction agent, handles the next user message)

---

## What This Means for Semantic Memory Injection

### What we DO NOT need to do

- Inject system prompt into the compaction output — the main agent already gets
  it fresh on every turn
- Inject tool definitions into the compaction output — the main agent already
  gets them fresh on every turn
- Use `output.prompt` to replace the entire compaction prompt — we only need to
  augment it

### What we DO need

After compaction, the summarized messages are hidden behind the summary. If those
messages contained references to semantic memory facts, the main agent loses
access to them. We need a way to surface recent memory chunks in the
post-compaction context.

The cleanest approach: inject recent memory chunks into the compaction agent's
prompt so they appear in the summary output, which the main agent sees in its
conversation history.

---

## Revised Proposed Approach

### Via `experimental.session.compacting` hook

```typescript
"experimental.session.compacting"?: (input: {
  sessionID: string;
}, output: {
  context: string[];   // appended to compaction agent's user message
  prompt?: string;     // replaces entire buildPrompt() output
}) => Promise<void>;
```

#### Option A: Use `output.context` (simpler)

Fetch recent memory chunks in the hook and push them as context strings:

```typescript
const chunks = await db.getRecentChunks(5)
const formatted = chunks.map((c, i) =>
  `[Memory Chunk ${i + 1}]\n${c.text}`
)
output.context.push("---", "Recent Semantic Memory Chunks:", ...formatted)
```

These strings are appended AFTER the `SUMMARY_TEMPLATE` in the compaction
agent's user message. The compaction agent sees them but they don't appear in
its output (the summary follows the template format, which doesn't include a
memory section).

**Downside**: The context strings are invisible to the main agent. They're just
extra noise in the compaction agent's prompt. The main agent never sees them.

#### Option B: Use `output.prompt` (requires template modification)

Replace the compaction prompt to instruct the compaction agent to include a
"Recent Memory Chunks" section in its summary output:

```
{anchor}

Output exactly the Markdown structure shown inside <template> and keep the
section order unchanged. Do not include the <template> tags in your response.

<template>
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
## Recent Memory Chunks
- [list recent memory chunks provided below]
## Relevant Files
</template>

...

Recent Memory Chunks to include:
{formatted chunks from DB}
```

The hook fetches chunks from the DB and includes them both in the instruction
("include these") and as data ("here are the chunks"). The compaction agent's
summary will then contain the chunks, and the main agent will see them in the
conversation history.

**Trade-off**: `output.prompt` replaces the ENTIRE `buildPrompt()` output,
including any context strings from OTHER plugins. This is a composition
problem.

### Recommendation

Use Option B (output.prompt) but merge any context from other plugins manually:

```typescript
const chunks = await db.getRecentChunks(5)
const formatted = chunks.map(...)

// Manually include other plugins' context strings
const allContext = [...existingContext, formatted.join("\n")]

output.prompt = buildCustomPrompt({
  previousSummary,
  context: allContext,
})
```

This requires the hook to replicate the `buildPrompt()` logic locally.

---

## Plugin Hook Implementation Notes

### What the hook can access

- `input.sessionID` — the session being compacted
- `output.context` — mutable array, push strings to append
- `output.prompt` — if set, replaces `buildPrompt()` entirely

### What the hook CANNOT access (without separate API calls)

- The previous summary text (must fetch via `client.session.messages()`)
- Agent config / permissions
- The actual memory chunks (must query the plugin's own DB)

### Required DB queries

```typescript
// 1. Get recent memory chunks
const chunks = await db.query(
  `SELECT text FROM chunks ORDER BY created_at DESC LIMIT 5`
)

// 2. (if using output.prompt) Get previous summary from session messages
const msgs = await client.session.messages({ sessionID: input.sessionID })
const lastSummary = msgs
  .filter(m => m.role === "assistant" && m.summary)
  .pop()
```

---

## Unverified Items

1. **`client.session.messages()` from within the hook** — the pattern is
   confirmed safe (no deadlock, used by opencode-orchestrator), but not tested
   in this specific plugin context
2. **Option B template format** — the exact wording that makes the compaction
   agent reliably include memory chunks needs testing. The compaction agent
   already broke once (stored reasoning shows it misunderstood its role)
3. **Token cost** — memory chunk text adds to the compaction prompt. For very
   large chunks, this could push the compaction agent over its own context limit
