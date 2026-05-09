import BaseWrapper from './base';
import { Concept } from '../db';
import * as dbo from '../dbo';

export default class AssistantWrapper extends BaseWrapper {
  async store(
    text: string,
    concepts?: Concept[],
    existingConceptIds?: number[],
    sources?: string[],
    memoryType?: string
  ): Promise<{ chunk: dbo.Chunk; concepts: dbo.Concept[] }> {
    const props: Record<string, string> = {};
    if (sources && sources.length > 0) {
      props.sources = JSON.stringify(sources);
    }
    if (memoryType) {
      props.memory_type = memoryType;
    }
    return this.insertChunk(text, concepts || [], existingConceptIds, Object.keys(props).length > 0 ? props : undefined);
  }

  async promoteToWorking(id: number): Promise<void> {
    await this.setProps(id, { memory_type: 'working' });
  }

  async demoteToArchival(id: number): Promise<void> {
    await this.setProps(id, { memory_type: 'archival' });
  }
}
