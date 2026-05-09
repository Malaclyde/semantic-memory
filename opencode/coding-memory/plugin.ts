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
    description: "Search stored knowledge using semantic + keyword + reranker fusion. Supports scope filtering and date range limits.",
    args: {
      query: tool.schema.string().describe("The search query"),
      limit: tool.schema.number().default(5).describe("Max results"),
      scope: tool.schema.string().optional().describe("Scope filter (e.g. 'frontend', 'backend'). Requires strict_scope=true to exclude unscoped chunks."),
      strict_scope: tool.schema.boolean().optional().describe("If true, only chunks with the exact scope match. If false, also includes chunks without any scope. Default: true."),
      older_than: tool.schema.string().optional().describe("ISO 8601 date string. Only return chunks created before this date (e.g. '2026-01-01' or '2026-01-01T00:00:00')."),
      younger_than: tool.schema.string().optional().describe("ISO 8601 date string. Only return chunks created after this date."),
    },
    async execute(args) {
      const filters: { propertyName: string; value: string; required: boolean }[] = [];

      if (args.scope) {
        const required = args.strict_scope !== false;
        filters.push({ propertyName: 'scope', value: args.scope, required });
      }

      const results = await memory.search(args.query, args.limit, {
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
    description: "Store a new fact into knowledge base. Use scope to organize knowledge by project area (e.g. 'frontend', 'backend', 'api'). Unscoped chunks match all searches.",
    args: {
      text: tool.schema.string().describe("The fact or knowledge to store"),
      concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
      existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("Reuse existing concept IDs"),
      sources: tool.schema.array(tool.schema.string()).optional().describe("Source URLs"),
      scope: tool.schema.string().optional().describe("Project area scope (e.g. 'frontend', 'backend'). Chunks without scope are found by all searches."),
    },
    async execute(args) {
      const concepts = (args.concepts || []).map(name => ({ name }));
      const result = await memory.store(args.text, concepts, args.existingConceptIds, args.sources, args.scope);
      return { output: JSON.stringify({ chunkId: Number(result.chunk.id), conceptIds: result.concepts.map(c => Number(c.id)) }) };
    },
  });

  const find_concept = tool({
    description: "Find a concept by name or description",
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
    description: "Retrieve full chunk texts by their IDs, including metadata",
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
    description: "Merge multiple chunks into one consolidated chunk",
    args: {
      sourceIds: tool.schema.array(tool.schema.number()).describe("Chunk IDs to merge"),
      targetText: tool.schema.string().describe("Consolidated text"),
      concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
    },
    async execute(args) {
      const concepts = (args.concepts || []).map(name => ({ name }));
      const result = await memory.merge(args.sourceIds, args.targetText, concepts);
      return { output: JSON.stringify({ newChunkId: Number(result.chunk.id) }) };
    },
  });

  const set_outdated = tool({
    description: "Mark a chunk as outdated (hidden from results)",
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
      set_outdated,
    },
  };
}
