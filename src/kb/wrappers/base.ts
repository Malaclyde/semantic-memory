import DB, { Concept, ChunkResult, CombinedSearchResult, ConceptSearchResult } from '../db';
import * as dbo from '../dbo';

export interface SearchOptions {
  filters?: { propertyName: string; value: string; required: boolean }[];
  scope?: string;
  memoryType?: string;
}

export default class BaseWrapper extends DB {
  async search(
    query: string,
    limit: number,
    options?: SearchOptions
  ): Promise<CombinedSearchResult[]> {
    const filters: { propertyName: string; value: string; required: boolean }[] = [];

    if (options?.filters) {
      filters.push(...options.filters);
    }
    if (options?.scope) {
      filters.push({ propertyName: 'scope', value: options.scope, required: true });
    }
    if (options?.memoryType) {
      filters.push({ propertyName: 'memory_type', value: options.memoryType, required: true });
    }

    const results = await this.combinedSearch(query, limit, filters.length > 0 ? filters : undefined);
    await this.#enrichSources(results);
    return results;
  }

  async store(
    text: string,
    concepts?: Concept[],
    existingConceptIds?: number[]
  ): Promise<{ chunk: dbo.Chunk; concepts: dbo.Concept[] }> {
    return this.insertChunk(text, concepts || [], existingConceptIds);
  }

  async getChunks(ids: number[]): Promise<ChunkResult[]> {
    const results = await this.getChunksByIds(ids);
    await this.#enrichSources(results);
    return results;
  }

  async #enrichSources(results: { id: number }[]): Promise<void> {
    for (const r of results) {
      const props = await this.getProps(r.id);
      if (props.sources) {
        (r as any).sources = JSON.parse(props.sources);
      }
    }
  }

  async getPreviews(conceptId: number, maxLen?: number): Promise<{ id: number; text: string }[]> {
    return this.getConceptChunks(conceptId, maxLen);
  }

  async findConcept(name: string, description?: string): Promise<ConceptSearchResult[]> {
    return this.conceptCombinedSearch(name, description || "");
  }

  async setOutdated(id: number): Promise<void> {
    return this.setChunkOutdated(id);
  }

  async editConcept(id: number, name: string, description: string): Promise<void> {
    return super.editConcept(id, name, description);
  }

  async setProps(id: number, props: Record<string, string>): Promise<void> {
    return this.setChunkProperties(id, props);
  }

  async getProps(id: number): Promise<Record<string, string>> {
    return this.getChunkProperties(id);
  }

  async delProp(id: number, name: string): Promise<void> {
    return this.deleteChunkProperty(id, name);
  }

  async merge(
    sourceIds: number[],
    targetText: string,
    targetConcepts?: Concept[]
  ): Promise<{ chunk: ChunkResult; concepts: dbo.Concept[] }> {
    return this.mergeChunks(sourceIds, targetText, targetConcepts || []);
  }
}
