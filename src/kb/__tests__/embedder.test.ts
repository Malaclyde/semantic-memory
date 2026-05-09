import { describe, it, expect, beforeAll } from 'vitest';
import Embedder from '../embedder';

const MODEL = { name: 'Xenova/all-MiniLM-L6-v2', numDimensions: 384 };
let embedder: Embedder;

beforeAll(async () => {
  embedder = new Embedder(MODEL.name, MODEL.numDimensions);
}, 120_000);

describe('Embedder', () => {
  it('returns Float32Array', async () => {
    const result = await embedder.embed('Hello world');
    expect(result).toBeInstanceOf(Float32Array);
  });

  it('returns correct dimensions', async () => {
    const result = await embedder.embed('Test');
    expect(result.length).toBe(384);
  });

  it('similar texts produce similar embeddings', async () => {
    const a = await embedder.embed('Crawl4AI is a web crawler');
    const b = await embedder.embed('Crawl4AI is a web scraper');
    const c = await embedder.embed('The weather is nice today');

    function cosine(a: Float32Array, b: Float32Array): number {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    const simAB = cosine(a, b);
    const simAC = cosine(a, c);

    expect(simAB).toBeGreaterThan(simAC);
  });

  it('empty string returns embedding', async () => {
    const result = await embedder.embed('');
    expect(result.length).toBe(384);
  });

  it('long text returns embedding', async () => {
    const longText = 'Lorem ipsum dolor sit amet. '.repeat(100);
    const result = await embedder.embed(longText);
    expect(result.length).toBe(384);
  });
});
