-- chunks table 
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    outdated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 0
);

-- virtual extension of the chunks table to store the embeddings
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    id INTEGER PRIMARY KEY UNIQUE NOT NULL,
    embedding float[${numDimensions}]
);

-- concepts table
CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT
);

-- concept <-> chunk edges
CREATE TABLE IF NOT EXISTS edges (
    chunk_id INTEGER NOT NULL,
    concept_id INTEGER NOT NULL,
    PRIMARY KEY (chunk_id, concept_id),
    FOREIGN KEY (chunk_id) REFERENCES chunks(id),
    FOREIGN KEY (concept_id) REFERENCES concepts(id)
);

-- virtual extension for concept embeddings
CREATE VIRTUAL TABLE IF NOT EXISTS vec_concepts USING vec0(
    id INTEGER PRIMARY KEY UNIQUE NOT NULL,
    embedding float[${numDimensions}]
);

-- FTS5 for concepts (keyword search over name + description)
CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(
    name, description,
    content='concepts',
    content_rowid='id'
);

-- FTS5 for chunks
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id');

-- Triggers to keep FTS in sync with chunks table
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Concept FTS sync triggers
CREATE TRIGGER IF NOT EXISTS concepts_ai AFTER INSERT ON concepts BEGIN
  INSERT INTO concepts_fts(rowid, name, description) VALUES (new.id, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS concepts_ad AFTER DELETE ON concepts BEGIN
  INSERT INTO concepts_fts(concepts_fts, rowid, name, description) VALUES ('delete', old.id, old.name, old.description);
END;

CREATE TRIGGER IF NOT EXISTS concepts_au AFTER UPDATE ON concepts BEGIN
  INSERT INTO concepts_fts(concepts_fts, rowid, name, description) VALUES ('delete', old.id, old.name, old.description);
  INSERT INTO concepts_fts(rowid, name, description) VALUES (new.id, new.name, new.description);
END;

-- properties table
CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- chunk_properties table
CREATE TABLE IF NOT EXISTS chunk_properties (
    chunk_id INTEGER NOT NULL,
    property_id INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (chunk_id, property_id),
    FOREIGN KEY (chunk_id) REFERENCES chunks(id),
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE INDEX IF NOT EXISTS idx_cp_lookup ON chunk_properties(property_id, value);