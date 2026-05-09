import { pipeline, FeatureExtractionPipeline, QuestionAnsweringPipeline } from '@huggingface/transformers';

export default class Embedder {
    static #pipe: undefined | Promise<FeatureExtractionPipeline>

    get pipe(): Promise<FeatureExtractionPipeline> {
        if (!Embedder.#pipe) {
            Embedder.#pipe = pipeline('feature-extraction', this.embeddingModel);
        }

        return Embedder.#pipe;
        // return new Promise((resolve, reject) => {
        //     if (Embedder.#pipe) {resolve(Embedder.#pipe)}

        //     pipeline('feature-extraction', EMBEDDING_MODEL)
        //         .then(pipe => { Embedder.#pipe = pipe; resolve(pipe) })
        //         .catch(err => reject(err))
        // });
    }

    constructor(public embeddingModel: string, public numDimensions: number) {}

    async embed(text: string): Promise<Float32Array> {
       const pipe = await this.pipe;
       const output = await pipe(text, { pooling: 'mean', normalize: true });

       return new Float32Array(output.data as ArrayLike<number>);
       // return Array.from(output.data);
    }
}