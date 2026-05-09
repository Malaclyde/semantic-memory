import usearch, { MetricKind } from 'usearch';

export interface SearchResult {
  id: number;
  distance: number;
}

export class VectorIndex {
  #index: InstanceType<typeof usearch.Index>;
  #numDimensions: number;

  constructor(numDimensions: number) {
    this.#numDimensions = numDimensions;
    this.#index = new usearch.Index({
      dimensions: this.#numDimensions,
      metric: MetricKind.Cos,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 64,
      quantization: usearch.ScalarKind.F32,
      multi: false,
    } as any);
  }

  async add(id: number, vector: Float32Array): Promise<void> {
    this.#index.add(BigInt(id), vector, 0);
  }

  async remove(id: number): Promise<void> {
    this.#index.remove(BigInt(id));
  }

  async search(vector: Float32Array, k: number): Promise<SearchResult[]> {
    const results = this.#index.search(vector, k, 0) as any as { keys: BigUint64Array; distances: Float32Array };
    const out: SearchResult[] = [];
    for (let i = 0; i < results.keys.length; i++) {
      out.push({ id: Number(results.keys[i]), distance: results.distances[i] });
    }
    return out;
  }

  async save(path: string): Promise<void> {
    this.#index.save(path);
  }

  async load(path: string): Promise<void> {
    this.#index = new usearch.Index({
      dimensions: this.#numDimensions,
      metric: MetricKind.Cos,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 64,
      quantization: usearch.ScalarKind.F32,
      multi: false,
    } as any);
    this.#index!.load(path);
  }

  get size(): number {
    return this.#index.size() as number;
  }

  clear(): void {
    this.#index = new usearch.Index({
      dimensions: this.#numDimensions,
      metric: MetricKind.Cos,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 64,
      quantization: usearch.ScalarKind.F32,
      multi: false,
    } as any);
  }
}
