import DB, { Concept, ChunkResult, CombinedSearchResult, ConceptSearchResult } from '../db';
import * as dbo from '../dbo';

export interface SearchOptions {
  filters?: { propertyName: string; value: string; required: boolean }[];
  scope?: string;
  memoryType?: string;
  strictScope?: boolean;
  olderThan?: string;
  youngerThan?: string;
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
      const required = options.strictScope !== false;
      filters.push({ propertyName: 'scope', value: options.scope, required });
    }
    if (options?.memoryType) {
      filters.push({ propertyName: 'memory_type', value: options.memoryType, required: true });
    }

    const results = await this.combinedSearch(
      query, limit,
      filters.length > 0 ? filters : undefined,
      options?.olderThan,
      options?.youngerThan,
    );
    await this.#enrichSources(results);
    await this.#enrichDates(results);
    return results;
  }

  async store(
    text: string,
    concepts?: Concept[],
    existingConceptIds?: number[],
    sources?: string[],
    scope?: string,
  ): Promise<{
    chunk: dbo.Chunk;
    concepts: dbo.Concept[];
    notes?: { type: "concept_exists"; name: string; id: number; description: string }[];
  }> {
    const props: Record<string, string> = {};
    if (sources && sources.length > 0) {
      props.sources = JSON.stringify(sources);
    }
    if (scope) {
      props.scope = scope;
    }

    const existingIds = [...(existingConceptIds || [])];
    const trulyNew: Concept[] = [];
    const notes: { type: "concept_exists"; name: string; id: number; description: string }[] = [];

    if (concepts && concepts.length > 0) {
      const names = concepts.map(c => c.name);
      const found = this.findConceptsByNames(names);
      const foundNames = new Set(found.map(f => f.name));

      for (const c of concepts) {
        if (foundNames.has(c.name)) {
          const f = found.find(x => x.name === c.name)!;
          existingIds.push(f.id);
          notes.push({ type: "concept_exists", name: f.name, id: f.id, description: f.description });
        } else {
          trulyNew.push(c);
        }
      }
    }

    const result = await this.insertChunk(
      text,
      trulyNew,
      existingIds,
      Object.keys(props).length > 0 ? props : undefined
    );

    return { ...result, notes: notes.length > 0 ? notes : undefined };
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

  async #enrichDates(results: { id: number }[]): Promise<void> {
    const ids = results.map(r => r.id);
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, created_at, access_count FROM chunks WHERE id IN (${placeholders})`
    ).all(...ids) as { id: number; created_at: string; access_count: number }[];
    for (const row of rows) {
      const r = results.find(x => x.id === row.id);
      if (r) {
        (r as any).created_at = row.created_at;
        (r as any).access_count = row.access_count;
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

  async unlinkConcept(chunkId: number, conceptId: number): Promise<number> {
    return this.removeConceptEdge(chunkId, conceptId);
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
    targetConcepts?: Concept[],
    existingConceptIds?: number[],
  ): Promise<{
    chunk: ChunkResult;
    concepts: dbo.Concept[];
    notes?: { type: "concept_exists"; name: string; id: number; description: string }[];
  }> {
    const existingIds = [...(existingConceptIds || [])];
    const trulyNew: Concept[] = [];
    const notes: { type: "concept_exists"; name: string; id: number; description: string }[] = [];

    if (targetConcepts && targetConcepts.length > 0) {
      const names = targetConcepts.map(c => c.name);
      const found = this.findConceptsByNames(names);
      const foundNames = new Set(found.map(f => f.name));

      for (const c of targetConcepts) {
        if (foundNames.has(c.name)) {
          const f = found.find(x => x.name === c.name)!;
          existingIds.push(f.id);
          notes.push({ type: "concept_exists", name: f.name, id: f.id, description: f.description });
        } else {
          trulyNew.push(c);
        }
      }
    }

    const result = await this.mergeChunks(sourceIds, targetText, trulyNew, existingIds);

    return {
      ...result,
      notes: notes.length > 0 ? notes : undefined,
    };
  }
}
