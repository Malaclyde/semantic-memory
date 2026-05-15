# OpenCode Mechanisms Research

Research date: 2026-05-10
Source: opencode docs (opencode.ai/docs), DeepWiki, GitHub issues, community articles

---

## 1. Context Compaction

### Overview

OpenCode's compaction is a two-tier mechanism in `packages/opencode/src/session/compaction.ts`:

1. **Prune first** — remove old tool outputs
2. **Summarize** — if pruning insufficient, generate a summary via a dedicated compaction agent

### Pruning Mechanism

- Walks backward through messages
- Protects the most recent ~40K tokens of tool outputs (safety cushion / `PRUNE_PROTECT`)
- Marks older tool outputs as `compacted`, replacing their content with `"[Old tool result content cleared]"`
- Only executes if it can free >20K tokens (`PRUNE_MINIMUM`), avoiding trivial cleanups
- Skill-type tool outputs are never pruned

### Summarization (Compaction Proper)

- Uses a dedicated `compaction` agent with `mode: "primary"` (hidden system agent, not user-selectable in UI)
- The compaction agent has **no tool permissions** (`PermissionNext.fromConfig({ "*": "deny" })`)
- Its prompt file is `PROMPT_COMPACTION` in `packages/opencode/src/agent/prompt/compaction.txt`
- Prompt asks for structured summary: Goal, Instructions, Discoveries, Accomplished, Relevant files
- By default uses the same model as the current conversation (inherited)
- Configurable via `agent.compaction.model` in opencode.json to use a cheaper/faster model

After summarization: `filterCompacted()` truncates history at the summary point, then the last user message is replayed so the agent can respond.

### Plugin Hook

`experimental.session.compacting` hook fires before the LLM generates the continuation summary. Plugins can:
- Inject additional context via `output.context.push(...)`
- Replace the entire compaction prompt via `output.prompt = "..."` (which also disables context injection)

Community plugin example: `opencode-archive-before-compaction` archives old context before it gets compacted.

### When Compaction Triggers

Two checkpoints in the session processing loop (processor.ts + prompt.ts):

1. **Pre-request check** (`prompt.ts:495-507`): Before sending a new user message, check if `lastFinished` already exceeded the limit
2. **Post-response check** (`processor.ts:274`): After each successful assistant response, check if this response pushed over the limit → return `"compact"` → triggers before next iteration

Additionally: manual trigger via `/compact` or `/summarize` command, or `<leader>c` keybinding.

### Trigger Threshold (What Percentage)

OpenCode does **not** use a percentage-based threshold. Instead:

```
output_reserved = min(model.limit.output, 32_000) || 32_000
usable = model.limit.input || (context - output_reserved)
compact_when = (tokens.input + tokens.cache.read + tokens.output) > usable
```

This reserves space for the model's next output. For Claude Sonnet 4.5 (200K context): triggers at ~168K (~84%). For Gemini 3 Flash (1M context): triggers at ~968K (~96.8%).

Configurable via:
- `compaction.auto` (boolean, default true) — enable/disable auto-compaction
- `compaction.prune` (boolean, default true) — enable/disable pruning
- `compaction.reserved` (number, since v1.1.57) — adjust reserved token buffer
- Environment: `OPENCODE_DISABLE_AUTOCOMPACT=true`
- Model-level `limit.context` override in provider config to effectively change trigger point

The old hardcoded 75% threshold (issue #11314) was replaced with the current formula that accounts for output token reservation. PR #18951 added configurable compaction.

### Community Best Practices

1. **Compact at task boundaries** — use `/compact` manually at natural stopping points rather than waiting for auto-compaction
2. **Keep AGENTS.md/CLAUDE.md comprehensive** — these files survive compaction intact; put conventions, decisions, and rules there
3. **Cheaper model for compaction** — configure compaction agent to use haiku-class model
4. **plugins** — use `experimental.session.compacting` hook for context injection
5. **Configure `compaction.reserved`** — increase if compaction keeps failing
6. **Per-agent compaction** — agents can disable compaction for themselves to avoid context loss

### Known Pain Points

- **Subagent context loss after compaction** (issue #6535) — subagents lose their specialized system prompts and start behaving incorrectly. Multiple related issues: #4483, #3031, #4102, #5934, #14368, #16960
- **Large AGENTS.md files** consume context and trigger immediate compaction (issue #18037)
- **Compaction overflow** — when the context is too large even for the compaction agent itself
- **Subagents not reading markdown instructions** from agent definition files after compaction (issue #8733)

---

## 2. Agent Spawning (Task Tool)

### Session Start with a Chosen Agent

- Agents defined in `packages/opencode/src/agent/agent.ts`
- Seven built-in agents: `build` (default primary), `plan` (restricted primary), `general` (subagent), `explore` (subagent), `scout` (subagent), plus hidden: `compaction`, `title`, `summary`
- Primary agents selectable via Tab key; subagents invoked via `@` mentions or task tool
- System prompt assembly (in `packages/opencode/src/session/prompt.ts`):
  1. Provider-specific system prompt (selected by model ID: anthropic.txt, beast.txt, gemini.txt, etc.)
  2. Agent's custom prompt (if defined) — replaces provider prompt
  3. Environment block (model name, working directory, platform, today's date)
  4. AGENTS.md / CLAUDE.md instruction files
  5. Tool definitions
  6. Mode fragments (plan.txt, build-switch.txt, max-steps.txt)
- Plugin hook `experimental.chat.system.transform` can mutate the final system array

### Subagent Spawning (via Task Tool)

When the LLM calls the `task` tool:

1. A **child session** is created for the subagent
2. The subagent gets its own **full prompt cycle** — exactly the same pipeline as the main agent
3. The subagent's prompt includes its own system prompt (or inherited), environment block, AGENTS.md
4. Plugins are loaded per-instance, so hooks DO fire for subagents too (issue #5894)
5. Tool access is filtered by two layers:
   - Built-in conditional inclusion (flags, config, model)
   - **Agent permissions** — each agent defines deny/allow/ask rules
6. Subagent runs with restricted permissions by default:
   - `general`: denies `todowrite` (to avoid cluttering TODO list)
   - `explore`: denies almost all tools except `grep`, `glob`, `list`, `bash`, `read`, web tools
   - `task` tool may be denied (prevents recursive subagent spawning unless explicitly allowed)

### What is Provided as System Prompt to the Spawned Agent

- Agent's custom prompt (if defined in config) OR provider-specific system prompt
- Environment block (same as main agent)
- AGENTS.md / CLAUDE.md instruction files
- Tool definitions (filtered by agent permissions)

### What Controls Tool Availability

Tool filtering happens at multiple stages:
1. **Registry initialization**: loads built-in + `.opencode/tool/` + plugin tools, applies flag/config filters
2. **Model-based filtering**: GPT models get `apply_patch` instead of `edit`/`write`
3. **Agent permissions**: each agent defines `permission` rules (deny/allow/ask per tool or glob pattern)
4. **Permission system**: at call time, checks against agent's permission ruleset

### What the Spawner Can Control

Via agent configuration in opencode.json (static):
- **System prompt**: `agent.<name>.prompt`
- **Model**: `agent.<name>.model` (if not set, inherits parent's model)
- **Temperature**: `agent.<name>.temperature`
- **Max steps**: `agent.<name>.steps` (formerly `maxSteps`)
- **Tool permissions**: `agent.<name>.permission` or `agent.<name>.tools` (true/false per tool)
- **Disable**: `agent.<name>.disable`
- **Mode**: `agent.<name>.mode` (primary/subagent/all)

When the task tool is invoked, the LLM chooses which subagent to delegate to based on description matching (the task tool description dynamically lists available subagents with their descriptions). The spawner cannot dynamically change subagent config at spawn time — all configuration is static.

### Compaction in Subagents

- Each subagent gets its **own context window** with its own compaction lifecycle
- Known issue: auto-compaction can cause the subagent to lose its original system prompt/context (issue #6535)
- Per-agent compaction disable is now possible (`agent.<name>.compaction.auto = false`)
- The compaction agent itself has no tools and runs its own dedicated prompt cycle

### User Interaction with Spawned Agents

Users can navigate into subagent sessions:
- `<leader>+right` (or `session_child_cycle`) — forward through parent → child → parent
- `<leader>+left` (or `session_child_cycle_reverse`) — backward
- The user sees the subagent's full conversation and can interact directly
- Subagents are also navigable via session list in the TUI

### Key Limitations / Issues

- Subagents don't inherit MCP tool permissions properly (issue #16491)
- Subagents can bypass plan mode restrictions (issue #26514, issue #26407)
- `@mention` doesn't guarantee subagent spawning — it injects a synthetic instruction (issue #19538)
- No dynamic model selection at task tool invocation time (issue #6651)
- Subagents may receive empty tools array in API call (issue #26394)
