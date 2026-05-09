import { AutoModelForSequenceClassification, AutoTokenizer, PreTrainedTokenizer, PreTrainedModel } from '@huggingface/transformers';

export default class Reranker {
    static #tokenizer: undefined | Promise<PreTrainedTokenizer>;
    static #model: undefined  | Promise<PreTrainedModel>;

    get tokenizer(): Promise<PreTrainedTokenizer> {
        if (!Reranker.#tokenizer) {
            Reranker.#tokenizer = AutoTokenizer.from_pretrained(this.tokenizerName);
        }

        return Reranker.#tokenizer;
    }

    get model(): Promise<PreTrainedModel> {
        if (!Reranker.#model) {
            Reranker.#model = AutoModelForSequenceClassification.from_pretrained(this.modelName);
        }

        return Reranker.#model;
    }

    constructor(public tokenizerName: string, public modelName: string) {}

    public async rank(query: string, document: string): Promise<number> {
        const tokenizer = await this.tokenizer;
        const model = await this.model;

        const inputs = tokenizer([document], { text_pair: [query], padding: true, truncation: true });
        const output: any = await model(inputs);

        // Single logit output — apply sigmoid for (0, 1) relevance probability
        const logit = output.logits.data[0] as number;
        return 1 / (1 + Math.exp(-logit));
    }
}