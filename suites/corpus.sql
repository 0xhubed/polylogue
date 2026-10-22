CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, body, content='docs', content_rowid='rowid', tokenize='porter unicode61');
