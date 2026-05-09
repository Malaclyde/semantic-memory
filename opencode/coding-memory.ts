import { tool } from "@opencode-ai/plugin";
import { CodingWrapper } from "semantic-memory";
import { Embedder } from "semantic-memory/kb/embedder";
import { Reranker } from "semantic-memory/kb/reranker";

const embedder = new Embedder("Xenova/all-MiniLM-L6-v2", 384);
const reranker = new Reranker("Xenova/bge-reranker-base", "Xenova/bge-reranker-base");
const memory = new CodingWrapper(embedder, reranker);

export const search_memory = tool({
  description: "Search stored knowledge using semantic + keyword + reranker fusion",
  args: {
    query: tool.schema.string().describe("The search query"),
    limit: tool.schema.number().default(5).describe("Max results"),
    scope: tool.schema.string().optional().describe("Optional scope filter (e.g. 'frontend', 'backend')"),
  },
  async execute(args) {
    const results = await memory.search(args.query, args.limit, { scope: args.scope });
    return results.map(r => ({
      id: r.id,
      text: r.text,
      score: r.rerankerScore,
      sources: (r as any).sources,
    }));
  },
});

export const store_memory = tool({
  description: "Store a new fact into knowledge base",
  args: {
    text: tool.schema.string().describe("The fact or knowledge to store"),
    concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
    existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("Reuse existing concept IDs"),
    sources: tool.schema.array(tool.schema.string()).optional().describe("Source URLs"),
  },
  async execute(args) {
    const concepts = (args.concepts || []).map(name => ({ name }));
    const result = await memory.store(args.text, concepts, args.existingConceptIds, args.sources);
    return { chunkId: Number(result.chunk.id), conceptIds: result.concepts.map(c => Number(c.id)) };
  },
});

export const find_concept = tool({
  description: "Find a concept by name or description",
  args: {
    name: tool.schema.string().describe("Concept name"),
    description: tool.schema.string().optional().describe("Optional description"),
  },
  async execute(args) {
    const results = await memory.findConcept(args.name, args.description || "");
    return results.map(r => ({
      id: Number(r.concept.id),
      name: r.concept.name,
      description: r.concept.description,
      score: r.score,
      linkedChunks: r.chunks.length,
    }));
  },
});

export const get_chunks = tool({
  description: "Retrieve full chunk texts by their IDs",
  args: {
    ids: tool.schema.array(tool.schema.number()).describe("Chunk IDs"),
  },
  async execute(args) {
    const results = await memory.getChunks(args.ids);
    return results.map(r => ({ id: r.id, text: r.text }));
  },
});

export const merge_memories = tool({
  description: "Merge multiple chunks into one consolidated chunk",
  args: {
    sourceIds: tool.schema.array(tool.schema.number()).describe("Chunk IDs to merge"),
    targetText: tool.schema.string().describe("Consolidated text"),
    concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
  },
  async execute(args) {
    const concepts = (args.concepts || []).map(name => ({ name }));
    const result = await memory.merge(args.sourceIds, args.targetText, concepts);
    return { newChunkId: Number(result.chunk.id) };
  },
});

export const set_outdated = tool({
  description: "Mark a chunk as outdated (hidden from results)",
  args: {
    id: tool.schema.number().describe("Chunk ID to mark outdated"),
  },
  async execute(args) {
    await memory.setOutdated(args.id);
    return "Done";
  },
});

export default {
  search_memory,
  store_memory,
  find_concept,
  get_chunks,
  merge_memories,
  set_outdated,
};
