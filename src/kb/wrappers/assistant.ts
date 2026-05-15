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
  ): Promise<{ chunk: dbo.Chunk; concepts: dbo.Concept[]; notes?: { type: "concept_exists"; name: string; id: number; description: string }[] }> {
    const result = await super.store(text, concepts, existingConceptIds, sources, undefined);
    if (memoryType) {
      await this.setProps(Number(result.chunk.id), { memory_type: memoryType });
    }
    return result as any;
  }

  async promoteToWorking(id: number): Promise<void> {
    await this.setProps(id, { memory_type: 'working' });
  }

  async demoteToArchival(id: number): Promise<void> {
    await this.setProps(id, { memory_type: 'archival' });
  }
}
