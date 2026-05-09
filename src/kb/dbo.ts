export interface Chunk {
    id?: BigInt,
    text: string,
    embedding: Float32Array
}

export interface Concept {
    id?: BigInt,
    name: string,
    description?: string
}