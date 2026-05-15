import { tool } from "@opencode-ai/plugin";
import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { AssistantWrapper } from "@malaclyde/knowledge-base";
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

export default async function AssistantMemoryPlugin(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const projectDir = input.directory;
  const dbPathOption = (options?.dbPath as string | undefined) || "project";
  const dbPath = resolveDbPath(dbPathOption, projectDir);
  const memory = new AssistantWrapper(embedder, reranker, { dbPath });

  const search_memory = tool({
    description: "Search stored memories, optionally filtered by memory type",
    args: {
      query: tool.schema.string().describe("The search query"),
      limit: tool.schema.number().default(5).describe("Max results"),
      memory_type: tool.schema.string().optional().describe("Filter by 'working' or 'archival'"),
    },
    async execute(args) {
      const results = await memory.search(args.query, args.limit, { memoryType: args.memory_type });
      return { output: JSON.stringify(results.map(r => ({
        id: r.id,
        text: r.text,
        score: r.rerankerScore,
        sources: (r as any).sources,
      }))) };
    },
  });

  const store_memory = tool({
    description: "Store a new memory with optional sources and memory type",
    args: {
      text: tool.schema.string().describe("The memory content"),
      concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
      existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("Reuse existing concept IDs"),
      sources: tool.schema.array(tool.schema.string()).optional().describe("Source URLs"),
      memory_type: tool.schema.string().optional().describe("'working' or 'archival'"),
    },
    async execute(args) {
      const concepts = (args.concepts || []).map(name => ({ name }));
      const result = await memory.store(args.text, concepts, args.existingConceptIds, args.sources, args.memory_type);

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
    description: "Retrieve full chunk texts by their IDs",
    args: {
      ids: tool.schema.array(tool.schema.number()).describe("Chunk IDs"),
    },
    async execute(args) {
      const results = await memory.getChunks(args.ids);
      return { output: JSON.stringify(results.map(r => ({ id: r.id, text: r.text, sources: (r as any).sources }))) };
    },
  });

  const promote_to_working = tool({
    description: "Promote a memory to working memory (always in context)",
    args: {
      id: tool.schema.number().describe("Chunk ID"),
    },
    async execute(args) {
      await memory.promoteToWorking(args.id);
      return "Promoted to working memory.";
    },
  });

  const demote_to_archival = tool({
    description: "Demote a memory to archival storage",
    args: {
      id: tool.schema.number().describe("Chunk ID"),
    },
    async execute(args) {
      await memory.demoteToArchival(args.id);
      return "Demoted to archival storage.";
    },
  });

  const merge_memories = tool({
    description: "Merge multiple memories into one consolidated entry",
    args: {
      sourceIds: tool.schema.array(tool.schema.number()).describe("Memory IDs to merge"),
      targetText: tool.schema.string().describe("Consolidated text"),
      concepts: tool.schema.array(tool.schema.string()).optional().describe("Concept names"),
      existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("IDs of existing concepts to link"),
      memory_type: tool.schema.string().optional().describe("Memory type for the merged result"),
    },
    async execute(args) {
      const concepts = (args.concepts || []).map(name => ({ name }));
      const result = await memory.merge(args.sourceIds, args.targetText, concepts, args.existingConceptIds);
      if (args.memory_type) {
        await memory.setProps(Number(result.chunk.id), { memory_type: args.memory_type });
      }

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
    description: "Detach a concept from a chunk without deleting the chunk. Use when a chunk was linked to the wrong concept and you want to fix the tag without losing the stored information.",
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
    description: "Mark a memory as outdated (hidden from results)",
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
      promote_to_working,
      demote_to_archival,
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
