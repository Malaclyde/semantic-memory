import BaseWrapper from './base';
import { Concept } from '../db';
import * as dbo from '../dbo';

export default class CodingWrapper extends BaseWrapper {
  async store(
    text: string,
    concepts?: Concept[],
    existingConceptIds?: number[],
    sources?: string[]
  ): Promise<{ chunk: dbo.Chunk; concepts: dbo.Concept[] }> {
    const props: Record<string, string> = {};
    if (sources && sources.length > 0) {
      props.sources = JSON.stringify(sources);
    }
    return this.insertChunk(
      text,
      concepts || [],
      existingConceptIds,
      Object.keys(props).length > 0 ? props : undefined
    );
  }
}
