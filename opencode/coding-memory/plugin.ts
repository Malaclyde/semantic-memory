import { tool } from "@opencode-ai/plugin";
import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import path from "path";
import os from "os";

function resolveDbPath(dbPathOption: string | undefined, projectDir: string): string {
  if (dbPathOption === "global") {
    return path.join(os.homedir(), ".cache", "opencode", "semantic-memory", "memory.db");
  }
  return path.join(projectDir, ".opencode", "semantic-memory", "memory.db");
}

// OpenCode installs npm plugins with ignoreScripts: true, which prevents
// better-sqlite3's install script (prebuild-install || node-gyp rebuild)
// from running. We ensure the native binding is built here.
function ensureNativeBinding(): void {
  const _require = createRequire(import.meta.url);
  let bsPath: string;
  try {
    bsPath = path.dirname(_require.resolve('better-sqlite3/package.json'));
  } catch {
    return;
  }
  if (existsSync(path.join(bsPath, 'build', 'Release', 'better_sqlite3.node'))) return;
  try {
    execSync('npx --yes prebuild-install', { cwd: bsPath, stdio: 'pipe', timeout: 30000 });
  } catch {
    execSync('npx --yes node-gyp rebuild --release', { cwd: bsPath, stdio: 'pipe', timeout: 120000 });
  }
}

ensureNativeBinding();

const { CodingWrapper } = await import('@malaclyde/knowledge-base');
const { default: Embedder } = await import('@malaclyde/knowledge-base/kb/embedder');
const { default: Reranker } = await import('@malaclyde/knowledge-base/kb/reranker');

const embedder = new Embedder("Xenova/all-MiniLM-L6-v2", 384);
const reranker = new Reranker("Xenova/bge-reranker-base", "Xenova/bge-reranker-base");

export default async function CodingMemoryPlugin(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const projectDir = input.directory;
  const dbPathOption = (options?.dbPath as string | undefined) || "project";
  const dbPath = resolveDbPath(dbPathOption, projectDir);
  const memory = new CodingWrapper(embedder, reranker, { dbPath });

  const search_memory = tool({
    description: "Search stored knowledge using semantic + keyword + reranker fusion",
    args: {
      query: tool.schema.string().describe("The search query"),
      limit: tool.schema.number().default(5).describe("Max results"),
      scope: tool.schema.string().optional().describe("Optional scope filter (e.g. 'frontend', 'backend')"),
    },
    async execute(args) {
      const results = await memory.search(args.query, args.limit, { scope: args.scope });
      return { output: JSON.stringify(results.map(r => ({
        id: r.id,
        text: r.text,
        score: r.rerankerScore,
        sources: (r as any).sources,
      }))) };
    },
  });

  const store_memory = tool({
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
    description: "Retrieve full chunk texts by their IDs",
    args: {
      ids: tool.schema.array(tool.schema.number()).describe("Chunk IDs"),
    },
    async execute(args) {
      const results = await memory.getChunks(args.ids);
      return { output: JSON.stringify(results.map(r => ({ id: r.id, text: r.text }))) };
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
