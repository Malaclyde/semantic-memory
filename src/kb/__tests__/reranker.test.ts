import { describe, it, expect, beforeAll } from 'vitest';
import Reranker from '../reranker';

const MODEL = { tokenizer: 'Xenova/bge-reranker-base', model: 'Xenova/bge-reranker-base' };
let reranker: Reranker;

beforeAll(async () => {
  reranker = new Reranker(MODEL.tokenizer, MODEL.model);
}, 120_000);

describe('Reranker', () => {
  it('returns a number between 0 and 1', async () => {
    const score = await reranker.rank(
      'web crawling',
      'Crawl4AI is an open-source LLM-friendly web crawler.'
    );
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('relevant document scores higher than irrelevant', async () => {
    const relevant = await reranker.rank(
      'web crawling',
      'Crawl4AI is an open-source LLM-friendly web crawler.'
    );
    const irrelevant = await reranker.rank(
      'web crawling',
      'The weather is nice today in Berlin.'
    );
    expect(relevant).toBeGreaterThan(irrelevant);
  });

  it('same query and document produces consistent scores', async () => {
    const a = await reranker.rank('test', 'This is a test document for reranking.');
    const b = await reranker.rank('test', 'This is a test document for reranking.');
    expect(a).toBe(b);
  });

  it('empty document returns a score', async () => {
    const score = await reranker.rank('test', '');
    expect(typeof score).toBe('number');
  });
});
