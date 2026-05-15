import { createDatabase } from './sqlite-adapter';
import type { Database, Statement } from './sqlite-adapter';
import { VectorIndex } from './vector-index';
import * as path from 'path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Embedder from './embedder';
import * as dbo from './dbo';
import Reranker from './reranker';

const _dirname = path.dirname(fileURLToPath(import.meta.url));

const FTS_SEARCH_LIMIT = 50;

export interface Concept {
    name: string,
    description?: string
}

export interface ChunkSearchResult extends dbo.Chunk {
    distance: number
}

export interface SemanticSearchResult {
    chunk: ChunkSearchResult,
    concepts: dbo.Concept[]
}

export interface KeywordSearchResult {
    rowid: number,
    text: string,
    rank: number
}

export interface VecSearchLightResult {
    id: number,
    distance: number
}

export interface ChunkResult {
    id: number,
    text: string
}

export interface CombinedSearchResult extends ChunkResult {
    distance?: number,
    ftsRank?: number,
    rerankerScore: number,
    created_at?: string,
    access_count?: number
}

export interface ConceptSearchResult {
    concept: dbo.Concept,
    chunks: { id: number, text: string }[],
    score: number
}

export interface ShadowChunkResult {
    id: number;
    text: string;
    properties: { name: string; value: string }[];
    concepts: { id: number; name: string; description: string }[];
}

export default class DB {
    #db: Database | undefined
    #dbPath: string
    #vectorIndex: VectorIndex
    
    #init(): Database {
        var db = createDatabase(this.#dbPath);

        try {
            const sql = fs.readFileSync(path.join(_dirname, 'sql', 'initialize.sql'), 'utf8').toString();
            db.exec(sql);
        } catch (error) {
            console.error(`failed to initialize the db: ${error}`)
            throw error;
        }

        // Migration: ensure UNIQUE constraint on concepts.name
        const uniqueIdx = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='concepts' AND name='uq_concepts_name'"
        ).get() as any;
        if (!uniqueIdx) {
            // Step 1: For each duplicate name, repoint edges from stale IDs to canonical ID
            db.exec(`
                CREATE TEMP TABLE _dup_map AS
                SELECT name, id AS stale_id, MIN(id) OVER (PARTITION BY name) AS canonical_id
                FROM concepts;
                
                DELETE FROM _dup_map WHERE stale_id = canonical_id;
                
                UPDATE edges
                SET concept_id = (SELECT canonical_id FROM _dup_map WHERE stale_id = edges.concept_id)
                WHERE concept_id IN (SELECT stale_id FROM _dup_map);
                
                DELETE FROM concepts WHERE id IN (SELECT stale_id FROM _dup_map);
                
                DROP TABLE _dup_map;
            `);
            // Step 2: Add unique index
            db.exec("CREATE UNIQUE INDEX uq_concepts_name ON concepts(name)");
        }

        return db;
    }

    // #region 'utils'

    #conceptText(concept: Concept): string {
        return concept.name + (concept.description ? ' ' + concept.description : '');
    }
    #ftsQuery(text: string): string {
        return text.split(/\s+/).map(token => {
            if (/[-\"*()]/.test(token)) return `"${token}"`;
            return token;
        }).join(' ');
    }

    // #endregion 'utils'

    // #region 'insert'

    #insertChunk(): Statement { return this.db.prepare('INSERT INTO chunks(text, embedding) VALUES (?, ?)'); }
    #insertConcept(): Statement { return this.db.prepare('INSERT INTO concepts(name, description, embedding) VALUES (?, ?, ?)'); }
    #insertEdge(): Statement { return this.db.prepare('INSERT OR IGNORE INTO edges(chunk_id, concept_id) VALUES (?, ?)'); }

    #insertChunkTransaction() { 
        return this.db.transaction((chunk: dbo.Chunk, concepts: { concept: dbo.Concept, embedding: string }[], existingConceptIds: number[]) => {
            chunk.id = BigInt(this.#insertChunk().run(chunk.text, Buffer.from(chunk.embedding.buffer)).lastInsertRowid);
            
            concepts.forEach(({ concept, embedding }) => {
                concept.id = BigInt(this.#insertConcept().run(concept.name, concept.description, Buffer.from(new Float32Array(JSON.parse(embedding)).buffer)).lastInsertRowid);
                this.#insertEdge().run(chunk.id, concept.id);
            });

            existingConceptIds.forEach(conceptId => {
                this.#insertEdge().run(chunk.id, conceptId);
            });

            return { chunk: chunk, concepts: concepts.map(c => c.concept) };
        }); 
    }
    
    // #endregion 'insert'

    // #region 'search'

    #conceptSearch(): Statement { return this.db.prepare(`
       SELECT *
       FROM concepts
       JOIN edges on concepts.id = edges.concept_id
       WHERE edges.chunk_id = ? 
    `); }
    #conceptFtsSearch(): Statement { return this.db.prepare(`
        SELECT rowid, rank
        FROM concepts_fts
        WHERE concepts_fts MATCH ?
        LIMIT ?
    `); }
    #conceptFtsNameSearch(): Statement { return this.db.prepare(`
        SELECT rowid, rank
        FROM concepts_fts
        WHERE name MATCH ?
        LIMIT ?
    `); }
    #ftsSearch(): Statement {
        return this.db.prepare(`
            SELECT c.id as rowid, c.text, f.rank
            FROM chunks_fts f
            JOIN chunks c ON f.rowid = c.id
            WHERE c.outdated = 0 AND f.text MATCH ?
            LIMIT ?
        `);
    }

    #getChunk(ids: number[]): ChunkResult[] {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        return this.db.prepare(`SELECT id, text FROM chunks WHERE id IN (${placeholders}) AND outdated = 0`).all(...ids) as ChunkResult[];
    }

    #upsertProperty(name: string): number {
        this.db.prepare('INSERT OR IGNORE INTO properties(name) VALUES (?)').run(name);
        return (this.db.prepare('SELECT id FROM properties WHERE name = ?').get(name) as { id: number }).id;
    }

    #incrementAccessCounts(ids: number[]): void {
        if (ids.length === 0) return;
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`UPDATE chunks SET access_count = access_count + 1 WHERE id IN (${placeholders})`).run(...ids);
    }

    #assembleShadowResults(rows: { id: number; text: string }[]): ShadowChunkResult[] {
        if (rows.length === 0) return [];
        const ids = rows.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');

        const propRows = this.db.prepare(`
            SELECT cp.chunk_id, p.name, cp.value
            FROM chunk_properties cp
            JOIN properties p ON cp.property_id = p.id
            WHERE cp.chunk_id IN (${placeholders})
        `).all(...ids) as { chunk_id: number; name: string; value: string }[];

        const conceptRows = this.db.prepare(`
            SELECT e.chunk_id, c.id, c.name, substr(c.description, 1, 100) as description
            FROM edges e
            JOIN concepts c ON e.concept_id = c.id
            WHERE e.chunk_id IN (${placeholders})
        `).all(...ids) as { chunk_id: number; id: number; name: string; description: string }[];

        const propsByChunk = new Map<number, { name: string; value: string }[]>();
        for (const row of propRows) {
            if (!propsByChunk.has(row.chunk_id)) propsByChunk.set(row.chunk_id, []);
            propsByChunk.get(row.chunk_id)!.push({ name: row.name, value: row.value });
        }

        const conceptsByChunk = new Map<number, { id: number; name: string; description: string }[]>();
        for (const row of conceptRows) {
            if (!conceptsByChunk.has(row.chunk_id)) conceptsByChunk.set(row.chunk_id, []);
            conceptsByChunk.get(row.chunk_id)!.push({
                id: row.id,
                name: row.name,
                description: row.description || ''
            });
        }

        return rows.map(r => ({
            id: r.id,
            text: r.text,
            properties: propsByChunk.get(r.id) || [],
            concepts: conceptsByChunk.get(r.id) || [],
        }));
    }

    // #endregion 'search'

    constructor(public embedder: Embedder, public reranker: Reranker, options?: { dbPath?: string }) {
        this.#dbPath = options?.dbPath || process.env.SEMANTIC_MEMORY_DB_PATH || './test.db';
        this.#vectorIndex = new VectorIndex(embedder.numDimensions);
    }

    public async initVectorIndex(): Promise<void> {
        this.#vectorIndex.clear();
        const rows = this.db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND outdated = 0').all() as { id: number; embedding: Buffer }[];
        for (const row of rows) {
            await this.#vectorIndex.add(row.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
        }
        const crows = this.db.prepare('SELECT id, embedding FROM concepts WHERE embedding IS NOT NULL').all() as { id: number; embedding: Buffer }[];
        for (const row of crows) {
            await this.#vectorIndex.add(row.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
        }
    }

    public get db(): Database {
        if (!this.#db) {
            this.#db = this.#init();
        }

        return this.#db;
    }


    public async insertChunk(chunk: string, concepts: Concept[] = [], existingConceptIds?: number[], properties?: Record<string, string>): Promise<{chunk: dbo.Chunk, concepts: dbo.Concept[]}> {
        const chunkEmbedding = await this.embedder.embed(chunk);
        const _chunk: dbo.Chunk = {
            text: chunk,
            embedding: chunkEmbedding
        };

        const newConcepts: { concept: dbo.Concept, embedding: string }[] = [];
        for (const concept of concepts) {
            const conceptEmbedding = await this.embedder.embed(this.#conceptText(concept));
            newConcepts.push({
                concept: { name: concept.name, description: concept.description },
                embedding: JSON.stringify(Array.from(conceptEmbedding))
            });
        }

        const _existingIds = existingConceptIds || [];

        return new Promise((resolve, reject) => {
            try {
                const result = this.#insertChunkTransaction()(_chunk, newConcepts, _existingIds);
                if (properties) {
                    this.setChunkProperties(Number(result.chunk.id!), properties);
                }
                this.#vectorIndex.add(Number(result.chunk.id), chunkEmbedding).catch(() => {});
                resolve(result);
            } catch (err) {
                reject(err);
            }
        });
    }

    public setChunkOutdated(id: number): void {
        this.db.prepare('UPDATE chunks SET outdated = 1 WHERE id = ?').run(id);
        this.#vectorIndex.remove(id).catch(() => {});
    }

    public async editConcept(id: number, name: string, description: string): Promise<void> {
        this.db.prepare('UPDATE concepts SET name = ?, description = ? WHERE id = ?').run(name, description, id);
        const embedding = await this.embedder.embed(this.#conceptText({ name, description }));
        this.db.prepare('UPDATE concepts SET embedding = ? WHERE id = ?').run(Buffer.from(embedding.buffer), id);
        await this.#vectorIndex.remove(id);
        await this.#vectorIndex.add(id, embedding);
    }

    public getChunksByIds(ids: number[]): ChunkResult[] {
        const results = this.#getChunk(ids);
        this.#incrementAccessCounts(results.map(r => r.id));
        return results;
    }

    public getConceptChunks(conceptId: number, maxLen: number = 100): { id: number, text: string }[] {
        const rows = this.db.prepare(`
            SELECT c.id, substr(c.text, 1, ?) as text
            FROM edges e
            JOIN chunks c ON e.chunk_id = c.id
            WHERE e.concept_id = ? AND c.outdated = 0
        `).all(maxLen, conceptId) as { id: number, text: string }[];
        const ids = rows.map(r => r.id);
        this.#incrementAccessCounts(ids);
        return rows;
    }

    public getConceptsByIds(ids: number[]): dbo.Concept[] {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        return this.db.prepare(`SELECT id, name, description FROM concepts WHERE id IN (${placeholders})`).all(...ids) as dbo.Concept[];
    }

    public findConceptsByNames(names: string[]): { id: number; name: string; description: string }[] {
        if (names.length === 0) return [];
        const placeholders = names.map(() => '?').join(',');
        return this.db.prepare(
            `SELECT id, name, substr(coalesce(description, ''), 1, 100) as description FROM concepts WHERE name IN (${placeholders})`
        ).all(...names) as { id: number; name: string; description: string }[];
    }

    public async semanticSearch(text: string, limit: number): Promise<SemanticSearchResult[]> {
        if (this.#vectorIndex.size === 0) return [];
        const embedding = await this.embedder.embed(text);
        const vecResults = await this.#vectorIndex.search(embedding, limit);
        const ids = vecResults.map(r => r.id);
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        const chunks: ChunkSearchResult[] = this.db.prepare(`SELECT c.id as id, c.text FROM chunks c WHERE c.id IN (${placeholders}) AND c.outdated = 0`).all(...ids) as ChunkSearchResult[];
        const idOrder = new Map(ids.map((id, i) => [id, i]));
        chunks.sort((a, b) => (idOrder.get(Number(a.id)) ?? 0) - (idOrder.get(Number(b.id)) ?? 0));
        chunks.forEach(c => { const r = vecResults.find(v => v.id === Number(c.id)); if (r) (c as any).distance = r.distance; });
        const concepts: dbo.Concept[][] = chunks.map(chunk => this.#conceptSearch().all(chunk.id)) as Array<Array<dbo.Concept>>;
        return chunks.map((chunk, idx) => ({ chunk, concepts: concepts[idx] }));
    }

    public async keywordSearch(text: String, limit: number): Promise<KeywordSearchResult[]> {
        return new Promise((resolve, reject) => {
            try {
                const result: KeywordSearchResult[] = this.#ftsSearch().all(this.#ftsQuery(text as string), limit) as Array<KeywordSearchResult>;
                resolve(result);
            } catch (err) {
                reject(err);
            }
        })
    }

    public async combinedSearch(text: string, limit: number, filters?: { propertyName: string; value: string; required: boolean }[], olderThan?: string, youngerThan?: string): Promise<CombinedSearchResult[]> {
        const vecResults: VecSearchLightResult[] = this.#vectorIndex.size > 0
            ? (await this.#vectorIndex.search(
            await this.embedder.embed(text),
            Math.max(10 * limit, FTS_SEARCH_LIMIT)
        )).map(r => ({ id: r.id, distance: r.distance }))
            : [];

        const ftsResults: KeywordSearchResult[] = this.#ftsSearch().all(this.#ftsQuery(text), Math.max(10 * limit, FTS_SEARCH_LIMIT)) as KeywordSearchResult[];

        // RRF merge
        const k = 60;
        const scores = new Map<number, number>();

        vecResults.forEach((r, i) => {
            scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + i + 1));
        });

        ftsResults.forEach((r, i) => {
            scores.set(r.rowid, (scores.get(r.rowid) || 0) + 1 / (k + i + 1));
        });

        // Top N candidates for reranking
        let candidates = Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([id]) => id);

        if (candidates.length === 0) return [];

        if (filters && filters.length > 0) {
            const candidateIds = candidates;
            const propsMap = new Map<number, Record<string, string>>();
            const placeholders = candidateIds.map(() => '?').join(',');
            const rows = this.db.prepare(`
                SELECT cp.chunk_id, p.name, cp.value
                FROM chunk_properties cp
                JOIN properties p ON cp.property_id = p.id
                WHERE cp.chunk_id IN (${placeholders})
            `).all(...candidateIds) as { chunk_id: number; name: string; value: string }[];

            for (const row of rows) {
                if (!propsMap.has(row.chunk_id)) propsMap.set(row.chunk_id, {});
                propsMap.get(row.chunk_id)![row.name] = row.value;
            }

            candidates = candidateIds.filter(id => {
                const props = propsMap.get(id) || {};
                return filters.every(f => {
                    const hasIt = f.propertyName in props;
                    const matches = hasIt && props[f.propertyName] === f.value;
                    return f.required ? matches : matches || !hasIt;
                });
            });

            if (candidates.length === 0) return [];
        }

        // Date filtering
        if (olderThan || youngerThan) {
            let dateSql = 'SELECT id FROM chunks WHERE 1=1';
            const dateParams: any[] = [];
            if (olderThan) { dateSql += ' AND created_at < ?'; dateParams.push(olderThan); }
            if (youngerThan) { dateSql += ' AND created_at > ?'; dateParams.push(youngerThan); }
            const validIds = (this.db.prepare(dateSql).all(...dateParams) as { id: number }[])
                .map(r => r.id);
            candidates = candidates.filter(id => validIds.includes(id));
            if (candidates.length === 0) return [];
        }

        // Build text lookup from FTS results
        const ftsTextMap = new Map<number, string>();
        ftsResults.forEach(r => ftsTextMap.set(r.rowid, r.text));

        // Fetch texts for candidates not in FTS results
        const missingIds = candidates.filter(id => !ftsTextMap.has(id));
        const fetchedChunks = this.#getChunk(missingIds);
        const textMap = new Map<number, string>();
        ftsTextMap.forEach((v, k) => textMap.set(k, v));
        fetchedChunks.forEach(c => textMap.set(c.id, c.text));

        // Build distance/rank lookup
        const vecDistMap = new Map<number, number>();
        vecResults.forEach(r => vecDistMap.set(r.id, r.distance));
        const ftsRankMap = new Map<number, number>();
        ftsResults.forEach(r => ftsRankMap.set(r.rowid, r.rank));

        // Rerank
        const reranked: { id: number; score: number }[] = [];
        for (const id of candidates) {
            const docText = textMap.get(id);
            if (!docText) continue;
            const score = await this.reranker.rank(text, docText);
            reranked.push({ id, score });
        }

        const results = reranked
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(r => ({
                id: r.id,
                text: textMap.get(r.id)!,
                distance: vecDistMap.get(r.id),
                ftsRank: ftsRankMap.get(r.id),
                rerankerScore: r.score
            }));

        this.#incrementAccessCounts(results.map(r => r.id));

        return results;
    }

    public async conceptCombinedSearch(name: string, description: string, limit: number = 5): Promise<ConceptSearchResult[]> {
        const searchText = this.#conceptText({ name, description });

        // Step 1: Try name-only FTS
        const safeName = this.#ftsQuery(name);
        const nameMatches = this.#conceptFtsNameSearch().all(safeName, limit) as { rowid: number, rank: number }[];

        if (nameMatches.length > 0 && nameMatches[0].rank > -1) {
            const conceptIds = nameMatches.map(m => m.rowid);
            const concepts = this.getConceptsByIds(conceptIds);
            return concepts.map(c => ({
                concept: c,
                chunks: this.getConceptChunks(Number(c.id)),
                score: 1.0
            })).slice(0, limit);
        }

        // Step 2: RRF + reranker on combined name+description
        const vecResults: VecSearchLightResult[] = this.#vectorIndex.size > 0
            ? (await this.#vectorIndex.search(
            await this.embedder.embed(searchText),
            Math.max(10 * limit, FTS_SEARCH_LIMIT)
        )).map(r => ({ id: r.id, distance: r.distance }))
            : [];

        const ftsResults = this.#conceptFtsSearch().all(this.#ftsQuery(searchText), Math.max(10 * limit, FTS_SEARCH_LIMIT)) as { rowid: number, rank: number }[];

        const k = 60;
        const scores = new Map<number, number>();

        vecResults.forEach((r, i) => scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + i + 1)));
        ftsResults.forEach((r, i) => scores.set(r.rowid, (scores.get(r.rowid) || 0) + 1 / (k + i + 1)));

        const candidates = Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([id]) => id);

        if (candidates.length === 0) return [];

        // Fetch concept texts for reranking
        const candidateConcepts = this.getConceptsByIds(candidates);
        const conceptTexts = new Map<number, string>();
        candidateConcepts.forEach(c => conceptTexts.set(Number(c.id), this.#conceptText({ name: c.name, description: c.description })));

        // Rerank
        const reranked: { id: number; score: number }[] = [];
        for (const id of candidates) {
            const ct = conceptTexts.get(id);
            if (!ct) continue;
            reranked.push({ id, score: await this.reranker.rank(searchText, ct) });
        }

        reranked.sort((a, b) => b.score - a.score);

        return reranked.map(r => {
            const concept = candidateConcepts.find(c => Number(c.id) === r.id)!;
            return {
                concept,
                chunks: this.getConceptChunks(r.id),
                score: r.score
            };
        });
    }

    public removeConceptEdge(chunkId: number, conceptId: number): number {
        return this.db.prepare(
            "DELETE FROM edges WHERE chunk_id = ? AND concept_id = ?"
        ).run(chunkId, conceptId).changes;
    }

    public setChunkProperties(chunkId: number, props: Record<string, string>): void {
        for (const [name, value] of Object.entries(props)) {
            const propertyId = this.#upsertProperty(name);
            this.db.prepare('INSERT OR REPLACE INTO chunk_properties(chunk_id, property_id, value) VALUES (?, ?, ?)').run(chunkId, propertyId, value);
        }
    }

    public getChunkProperties(chunkId: number): Record<string, string> {
        const rows = this.db.prepare(`
            SELECT p.name, cp.value
            FROM chunk_properties cp
            JOIN properties p ON cp.property_id = p.id
            WHERE cp.chunk_id = ?
        `).all(chunkId) as { name: string, value: string }[];
        const result: Record<string, string> = {};
        for (const row of rows) {
            result[row.name] = row.value;
        }
        return result;
    }

    public deleteChunkProperty(chunkId: number, propertyName: string): void {
        this.db.prepare(`
            DELETE FROM chunk_properties WHERE chunk_id = ? AND property_id = (SELECT id FROM properties WHERE name = ?)
        `).run(chunkId, propertyName);
    }

    public getChunksByProperty(propertyName: string, value: string): ChunkResult[] {
        return this.db.prepare(`
            SELECT c.id, c.text
            FROM chunks c
            JOIN chunk_properties cp ON cp.chunk_id = c.id
            JOIN properties p ON cp.property_id = p.id
            WHERE p.name = ? AND cp.value = ? AND c.outdated = 0
        `).all(propertyName, value) as ChunkResult[];
    }

    public async mergeChunks(sourceIds: number[], targetText: string, targetConcepts?: Concept[], existingConceptIds?: number[]): Promise<{ chunk: ChunkResult; concepts: dbo.Concept[] }> {
        const result = await this.insertChunk(targetText, targetConcepts || [], existingConceptIds);
        
        if (sourceIds.length > 0) {
            const sourceProps = this.getChunkProperties(sourceIds[0]);
            this.setChunkProperties(Number(result.chunk.id!), sourceProps);
        }
        
        for (const id of sourceIds) {
            this.setChunkOutdated(id);
        }
        
        return {
            chunk: { id: Number(result.chunk.id), text: result.chunk.text },
            concepts: result.concepts
        };
    }

    public getRecentChunks(x: number): ShadowChunkResult[] {
        if (!Number.isInteger(x) || x < 1) {
            throw new Error('X must be a positive integer');
        }
        const rows = this.db.prepare(`
            SELECT id, substr(text, 1, 200) as text FROM chunks WHERE outdated = 0 ORDER BY created_at DESC LIMIT ?
        `).all(x) as { id: number; text: string }[];
        return this.#assembleShadowResults(rows);
    }

    public getMostAccessedChunks(x: number): ShadowChunkResult[] {
        if (!Number.isInteger(x) || x < 1) {
            throw new Error('X must be a positive integer');
        }
        const rows = this.db.prepare(`
            SELECT id, substr(text, 1, 200) as text FROM chunks WHERE outdated = 0 ORDER BY access_count DESC LIMIT ?
        `).all(x) as { id: number; text: string }[];
        return this.#assembleShadowResults(rows);
    }

    public getImportantChunks(x: number): ShadowChunkResult[] {
        if (!Number.isInteger(x) || x < 1) {
            throw new Error('X must be a positive integer');
        }
        const step1Limit = Math.ceil(x / 2);
        const step2Limit = x - step1Limit;

        const ids = this.db.prepare(`
            WITH recent AS (
                SELECT id, access_count, created_at
                FROM chunks
                WHERE outdated = 0
                ORDER BY created_at DESC
                LIMIT ?
            ),
            step1 AS (
                SELECT id FROM recent
                ORDER BY access_count DESC
                LIMIT ?
            ),
            step2 AS (
                SELECT id FROM chunks
                WHERE outdated = 0
                    AND id NOT IN (SELECT id FROM step1)
                ORDER BY access_count DESC
                LIMIT ?
            )
            SELECT id FROM step1
            UNION ALL
            SELECT id FROM step2
        `).all(x, step1Limit, step2Limit) as { id: number }[];

        const chunkIds = ids.map(r => r.id);
        if (chunkIds.length === 0) return [];
        const placeholders = chunkIds.map(() => '?').join(',');
        const rows = this.db.prepare(`
            SELECT id, substr(text, 1, 200) as text FROM chunks WHERE id IN (${placeholders})
        `).all(...chunkIds) as { id: number; text: string }[];

        const idOrder = new Map(chunkIds.map((id, i) => [id, i]));
        rows.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));

        return this.#assembleShadowResults(rows);
    }

}