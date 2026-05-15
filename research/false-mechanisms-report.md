# False Mechanisms Report — How I Arrived at Wrong Conclusions

Date: 2026-05-14
Author: the LLM (opencode agent)

---

## Executive Summary

I made a series of incorrect assumptions about OpenCode's compaction mechanism
that led to a fundamentally flawed design proposal in `compaction-override.md`.
The core error: I assumed compaction replaces the entire context window (system
prompt, tools, and messages) with just the compaction summary. In reality,
compaction only reorders messages in the conversation history. The system prompt
and tools are reconstructed fresh every agent loop iteration.

This document traces exactly how each wrong conclusion was reached, what evidence
was available but ignored, and what the truth is.

---

## Error 1: "The compaction output replaces the entire context"

### What I claimed

> "The compaction output becomes the post-compaction context"

This was the foundational assumption in `compaction-override.md`. The entire
design of injecting system prompt + tools + memory chunks into the compaction
output was built on this premise.

### How I arrived at it

I read `compaction.ts` in isolation — specifically the `processCompaction`
function that creates the summary. I saw:
1. A new assistant message with `mode: "compaction"`, `summary: true` is created
2. The `filterCompacted()` function reorders messages

I then jumped to the conclusion that the summary REPLACES all previous context.
I never read the agent loop in `prompt.ts` to see what happens *after*
compaction completes.

### What the code actually does

The agent loop at `prompt.ts:1698-1708`:

```typescript
if (task?.type === "compaction") {
  const result = yield* compaction.process({
    messages: msgs,
    parentID: lastUser.id,
    sessionID,
    auto: task.auto,
    overflow: task.overflow,
  })
  if (result === "stop") break
  continue   // ← KEY: goes back to top of loop
}
```

After `continue`, the next iteration:
1. Calls `filterCompactedEffect(sessionID)` to get reordered messages
2. Finds the next user message
3. Resolves the agent (`agents.get(lastUser.agent)`) — gets the BUILD agent
4. Resolves tools fresh (`resolveTools()` at line 1770)
5. Assembles system prompt fresh (`env + instructions + skills` at line 1818)
6. Passes everything to `handle.process()` normally

### Evidence that was available but ignored

- The `continue` keyword after compaction processing — I saw it but didn't trace
  what happens in the next iteration
- The database showed I used tools extensively after compaction (bash, sqlite3,
  read, grep, task) — if tools were stripped, I couldn't have
- The agent loop builds system prompt AND tools on every iteration — this was in
  the same file I read earlier

### Why I didn't catch it

I read `compaction.ts` in a focused way and formed a mental model. When I later
read parts of `prompt.ts`, I didn't connect the flow — I assumed the compaction
output was a dead end that replaced everything, rather than a detour that re-joins
the main path.

---

## Error 2: "The system prompt and tools need to be preserved in the compaction output"

### What I claimed

> "The original system prompt, tool list, and recent memory chunks survive
> compaction verbatim" — implying they would be LOST without our injection.

### How I arrived at it

Direct consequence of Error 1. If compaction replaces the context, then the
system prompt and tools disappear from the post-compaction view. The "solution"
was to inject them into the compaction summary.

### What the code actually does

System prompt and tools are NEVER part of the message history. They are
assembled fresh at lines 1770-1818 of `prompt.ts` on every LLM call:

```typescript
const tools = yield* resolveTools({ agent, session, model, ... })
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
])
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
```

Compaction does not touch this code path at all. The system prompt and tools
are not in the database as messages — they're ephemeral, constructed per-call.

---

## Error 3: "`output.context` is insufficient because context comes after the template"

### What I claimed

> "Our injected strings come AFTER the template. The compaction agent reads them
> but still outputs the standard template structure."

### How I arrived at it

Correct observation about WHERE context strings appear in the prompt. Wrong
conclusion about what we need. I assumed we needed to modify the compaction
agent's OUTPUT to include system prompt + tools. Since `output.context` strings
are just input to the compaction agent and don't appear in its output, I deemed
it insufficient.

### What's actually true

The `output.context` approach is perfectly fine for injecting memory chunks.
The context strings appear in the compaction agent's prompt as extra text. If we
want them in the summary output, we can:
1. Use `output.prompt` to replace the template and instruct the compaction agent
   to include them
2. Or just accept that they're noise in the compaction prompt

But the whole premise was wrong anyway — we don't need to inject system prompt
or tools via compaction at all.

---

## Error 4: "The compaction agent sees the conversation as a user showing them something"

### What I claimed

In the research, I wrote that the compaction agent's reasoning showed it was
confused about its role, and the system prompt doesn't include tool access.

### What's actually true

This part was actually CORRECT. The compaction agent:
- Uses `compaction.txt` as its system prompt
- Has `tools: {}`
- Receives the HEAD messages + `buildPrompt()` output as its user message

The evidence from the database confirmed this — the compaction agent's stored
reasoning shows it was confused. But this is a SEPARATE issue from the main
agent's context after compaction.

---

## Root Cause Analysis

### Why did I make these errors?

1. **Narrow code reading**: I read `compaction.ts` in depth but only skimmed
   `prompt.ts`. I never traced the full loop flow from compaction detection
   through completion back to normal processing.

2. **Premature conclusion**: The `filterCompacted()` function's reordering
   looked like it was "replacing" the context. I latched onto this visual
   pattern without verifying how the reordered messages are actually used.

3. **Confirmation bias**: I was designing a feature (injecting semantic memory
   into compaction). I interpreted ambiguous evidence in ways that supported
   the feature's necessity.

4. **Didn't test against reality**: I could have queried the database to check
   whether I had tools after compaction (I did — the session logs show me using
   bash, sqlite3, read, grep, task extensively). I never thought to verify.

5. **Didn't read the full loop**: The `continue` at line 1707 was right there.
   If I had read 10 more lines to see the next iteration resolves agent, tools,
   and system fresh, I would have caught the error immediately.

### How to prevent in the future

- Before claiming a mechanism works a certain way, trace the COMPLETE code path
- Verify claims against observable reality (database, logs, tool usage)
- Look for `continue`, `break`, and loop boundaries — they matter
- Question assumptions that make your feature "necessary" — is it actually needed,
  or are you seeing what you want to see?

---

## What was actually correct

Not everything was wrong:

| Claim | Verdict |
|-------|---------|
| Compaction spawns a separate LLM call with `tools: {}` | CORRECT |
| Compaction uses `compaction.txt` system prompt | CORRECT |
| `filterCompacted()` reorders messages | CORRECT |
| The hook `experimental.session.compacting` exists with `context` and `prompt` outputs | CORRECT |
| `UserMessage.system` is almost always undefined | CORRECT |
| `client.session.messages()` is safe to call from hooks | NOT VERIFIED but likely correct |
| The compaction agent broke its instructions in practice | CORRECT (confirmed in DB) |

---

## Timeline of Errors

1. Read `compaction.ts` — understood the compaction agent, summary creation,
   plugin hook
2. Read `buildPrompt()` — understood the template, `output.context`, `output.prompt`
3. **Saw `filterCompacted()` reorder messages and assumed it replaced context**
4. Wrote `compaction-override.md` with the wrong model
5. Created the proposed `output.prompt` — entirely unnecessary
6. User typed `/compact` and discovered the compaction agent broke
7. User asked me to investigate — I cloned the repo, read the code
8. **Still didn't read the agent loop continuation** — kept the wrong model
9. User forced me to check the DB — saw tools were available after compaction
10. Finally read `prompt.ts:1698-1708` and realized the `continue`
11. Traced the next iteration — found fresh system + tools reconstruction
12. **Fully understood the error**
