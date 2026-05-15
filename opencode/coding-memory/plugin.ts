import { tool } from "@opencode-ai/plugin";
import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { CodingWrapper } from "@malaclyde/knowledge-base";
import Embedder from "@malaclyde/knowledge-base/kb/embedder";
import Reranker from "@malaclyde/knowledge-base/kb/reranker";
import path from "path";
import os from "os";

function resolveDbPath(dbPathOption: string | undefined, projectDir: string): string {
  if (dbPathOption === "global") {
    return path.join(os.homedir(), ".cache", "opencode", "semantic-memory", "memory.db");
  }
  return path.join(projectDir, ".opencode", "semantic-memory", "memory.db");
}

const embedder = new Embedder("Xenova/all-MiniLM-L6-v2", 384);
const reranker = new Reranker("Xenova/bge-reranker-base", "Xenova/bge-reranker-base");

export default async function CodingMemoryPlugin(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const projectDir = input.directory;
  const dbPathOption = (options?.dbPath as string | undefined) || "project";
  const dbPath = resolveDbPath(dbPathOption, projectDir);
  const memory = new CodingWrapper(embedder, reranker, { dbPath });

  const search_memory = tool({
    description: "Search knowledge base for stored facts, decisions, conventions, and research results. Results include relevance scores. Filter by scope (component, service, subsystem name) and optional date range. Set strict_scope=false to also include unscoped chunks alongside scope match.",
    args: {
      query: tool.schema.string().describe("The search query"),
      limit: tool.schema.number().default(5).describe("Max results"),
      scope: tool.schema.string().optional().describe("Scope filter (e.g. a service or module name). Requires strict_scope=true to exclude unscoped chunks."),
      strict_scope: tool.schema.boolean().optional().describe("If true, only chunks with the exact scope match. If false, also includes chunks without any scope. Default: true."),
      older_than: tool.schema.string().optional().describe("ISO 8601 date string. Only return chunks created before this date (e.g. '2026-01-01' or '2026-01-01T00:00:00')."),
      younger_than: tool.schema.string().optional().describe("ISO 8601 date string. Only return chunks created after this date."),
    },
    async execute(args) {
      const effectiveLimit = args.limit ?? 5;
      const filters: { propertyName: string; value: string; required: boolean }[] = [];

      if (args.scope) {
        const required = args.strict_scope !== false;
        filters.push({ propertyName: 'scope', value: args.scope, required });
      }

      const results = await memory.search(args.query, effectiveLimit, {
        filters: filters.length > 0 ? filters : undefined,
        olderThan: args.older_than,
        youngerThan: args.younger_than,
      });

      return { output: JSON.stringify(results.map(r => ({
        id: r.id,
        text: r.text,
        score: r.rerankerScore,
        sources: (r as any).sources,
        created_at: (r as any).created_at,
        access_count: (r as any).access_count,
      }))) };
    },
  });

  const store_memory = tool({
    description: "Store fact in persistent memory. Use scope to organize by component, service, or subsystem; unscoped entries appear in all searches.\n\nRules:\n- 3–5 sentences per entry, ONE narrow topic only\n- Focus on factual essence, not changes to specific plan\n- Before calling, use `find_concept` to reuse existing concept names\n\nBad (too long, two unrelated topics, plan-specific calculation):\ntext: \"Gumroad charges 10% + $0.50 plus 2.9% card processing, so a €29 product costs €4.48 in fees. Austrian side income for employees is taxed at marginal rate...\" [cut 25 more lines]\nconcepts: [\"Gumroad\", \"Austrian Tax\"]\n\nGood — split into focused chunks:\n① text: \"Gumroad operates as the Merchant of Record, handling EU VAT globally. Its direct-sale fee structure combines a 10% platform fee plus $0.50 with a separate 2.9% plus $0.30 card processing fee. Discover marketplace sales are a flat 30% rate including processing costs.\"\nconcepts: [\"Gumroad\", \"Merchant of Record\", \"Platform Fees\", \"Payment Processing\"]\nsources: [\"https://gumroad.com/pricing\"]\n\n② text: \"In Austria the annual tax-free amount (Grundfreibetrag) applies to total income, not side income separately. For employees, all side business income is taxed at the highest marginal rate, as lower brackets are consumed by the primary salary.\"\nconcepts: [\"Austrian Tax Law\", \"Marginal Tax Rate\", \"Grundfreibetrag\", \"Side Business\"]\nsources: [\"https://bmf.gv.at\"]\n\nTriggers:\n- Completed research → split findings into 3–5 sentence chunks, store each\n- Discovered fact/constraint/convention → store it\n\nIf concept name already exists, linked automatically. Response includes existing concept ID and description. If wrong concept linked, use `unlink_concept(chunk_id, concept_id)` to detach.",
    args: {
      text: tool.schema.string().describe("The fact or knowledge to store"),
      concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
      existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("Reuse existing concept IDs"),
      sources: tool.schema.array(tool.schema.string()).optional().describe("Source URLs"),
      scope: tool.schema.string().optional().describe("Project area scope (e.g. a service or module name). Chunks without scope are found by all searches."),
    },
    async execute(args) {
      const concepts = (args.concepts || []).map(name => ({ name }));
      const result = await memory.store(args.text, concepts, args.existingConceptIds, args.sources, args.scope);

      let output = JSON.stringify({
        chunkId: Number(result.chunk.id),
        conceptIds: result.concepts.map(c => Number(c.id)),
      });

      if (result.notes && result.notes.length > 0) {
        const lines = result.notes.map(n =>
          `- "${n.name}" (ID: ${n.id}) — ${n.description}`
        );
        output += "\n\nNote: the following concepts already existed and were linked automatically:";
        output += "\n" + lines.join("\n");
        output += "\n\nIf any of these are incorrect, use `unlink_concept(chunk_id, concept_id)` to detach them.";
      }

      return { output };
    },
  });

  const find_concept = tool({
    description: "Find existing concepts by name or description. Always call before store_memory to check if concept exists — reuse exact names to merge related chunks under shared concepts, avoid duplicates. Pass found concept IDs to store_memory via existingConceptIds to link.",
    args: {
      name: tool.schema.string().describe("Concept name"),
      description: tool.schema.string().optional().describe("Optional description"),
    },
    async execute(args) {
      const results = await memory.findConcept(args.name, args.description || "");
      return { output: JSON.stringify(results.map(r => ({
        id: Number(r.concept.id),
        name: r.concept.name,
        description: r.concept.description,
        score: r.score,
        linkedChunks: r.chunks.length,
      }))) };
    },
  });

  const get_chunks = tool({
    description: "Retrieve full chunk texts by ID. Use to load complete text for chunks referenced by ID in system prompt or conversation context. Returns full text with created_at, access_count, sources metadata.",
    args: {
      ids: tool.schema.array(tool.schema.number()).describe("Chunk IDs"),
    },
    async execute(args) {
      const results = await memory.getChunks(args.ids);
      const placeholders = args.ids.map(() => '?').join(',');
      const rows = memory.db.prepare(
        `SELECT id, created_at, access_count FROM chunks WHERE id IN (${placeholders})`
      ).all(...args.ids) as { id: number; created_at: string; access_count: number }[];
      return { output: JSON.stringify(results.map(r => {
        const meta = rows.find(row => row.id === r.id);
        return {
          id: r.id,
          text: r.text,
          created_at: meta?.created_at,
          access_count: meta?.access_count,
          sources: (r as any).sources,
        };
      })) };
    },
  });

  const merge_memories = tool({
    description: "Merge multiple chunks covering same narrow topic into one consolidated entry. Source chunks marked outdated; merged result replaces them. Merged text must still follow 3–5 sentence rule.\n\nIf concept name already exists, linked automatically (same dedup behavior as store_memory). Use existingConceptIds to pass pre-looked-up concept IDs.",
    args: {
      sourceIds: tool.schema.array(tool.schema.number()).describe("Chunk IDs to merge"),
      targetText: tool.schema.string().describe("Consolidated text"),
      concepts: tool.schema.array(tool.schema.string()).optional().describe("Concept names"),
      existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("IDs of existing concepts to link"),
    },
    async execute(args) {
      const concepts = (args.concepts || []).map(name => ({ name }));
      const result = await memory.merge(args.sourceIds, args.targetText, concepts, args.existingConceptIds);

      let output = JSON.stringify({ newChunkId: Number(result.chunk.id) });

      if (result.notes && result.notes.length > 0) {
        const lines = result.notes.map(n =>
          `- "${n.name}" (ID: ${n.id}) — ${n.description}`
        );
        output += "\n\nNote: the following concepts already existed and were linked automatically:";
        output += "\n" + lines.join("\n");
        output += "\n\nIf any of these are incorrect, use `unlink_concept(chunk_id, concept_id)` to detach them.";
      }

      return { output };
    },
  });

  const unlink_concept = tool({
    description: "Detach concept from chunk without deleting chunk. Use when chunk linked to wrong concept and you want to fix tag without losing stored information.",
    args: {
      chunk_id: tool.schema.number().describe("ID of the chunk to unlink from"),
      concept_id: tool.schema.number().describe("ID of the concept to detach"),
    },
    async execute(args) {
      const deleted = await memory.unlinkConcept(args.chunk_id, args.concept_id);
      if (deleted === 0) {
        return { output: "No such edge exists. The chunk may already be unlinked from this concept, or the IDs may be wrong." };
      }
      return { output: `Concept ${args.concept_id} unlinked from chunk ${args.chunk_id}. To link a replacement concept, use \`store_memory\` with \`existingConceptIds\` or \`merge_memories\`.` };
    },
  });

  const set_outdated = tool({
    description: "Mark chunk as outdated, hiding from all future searches. If replacing obsolete information: call set_outdated on old chunk, then store_memory the corrected entry with appropriate concepts.\n\nTrigger: you retrieved information you know to be false → set it outdated, then store corrected version.",
    args: {
      id: tool.schema.number().describe("Chunk ID to mark outdated"),
    },
    async execute(args) {
      await memory.setOutdated(args.id);
      return "Done";
    },
  });

  return {
    tool: {
      search_memory,
      store_memory,
      find_concept,
      get_chunks,
      merge_memories,
      unlink_concept,
      set_outdated,
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const chunks = memory.getImportantChunks(5)
      if (chunks.length === 0) return

      const header = [
        "<semantic-memory>",
        "The 5 most important facts from the project knowledge base, selected by recency and access frequency.",
        "Use `search_memory` to find additional context by keyword, concept, or date range.",
        "",
      ].join("\n")

      const body = chunks
        .map((c, i) => `${i + 1}. [ID: ${c.id}] ${c.text}`)
        .join("\n")

      output.system.push(header + body + "\n</semantic-memory>")
    },
  };
}
