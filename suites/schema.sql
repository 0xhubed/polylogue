CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  split TEXT NOT NULL CHECK (split IN ('candidate', 'pilot', 'scored')),
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  match TEXT NOT NULL CHECK (match IN ('exact', 'contains', 'numeric')),
  corpus TEXT,
  info TEXT NOT NULL DEFAULT '{}'
);
