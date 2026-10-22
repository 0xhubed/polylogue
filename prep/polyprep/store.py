"""SQLite files under data/<suite>/, with the shared SQL in suites/."""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from polyprep import ROOT
from polyprep.verify import numeric_key

SCHEMA = (ROOT / "suites" / "schema.sql").read_text()
CORPUS = (ROOT / "suites" / "corpus.sql").read_text()


def open_tasks(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    return con


def put_task(con, *, id, split, prompt, answer, match, aliases=(), corpus=None, info=None, commit=True) -> None:
    if match == "numeric":
        for key in (answer, *aliases):
            if numeric_key(key) is None:
                raise ValueError(f"task {id}: numeric answer key {key!r} is not exactly one number")
    con.execute(
        "INSERT OR REPLACE INTO tasks (id, split, prompt, answer, aliases, match, corpus, info) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (id, split, prompt, answer, json.dumps(list(aliases)), match, corpus, json.dumps(info or {})),
    )
    if commit:
        con.commit()


def set_split(con, task_id: str, split: str) -> None:
    con.execute("UPDATE tasks SET split = ? WHERE id = ?", (split, task_id))
    con.commit()


def set_meta(con, key: str, value: str, commit=True) -> None:
    con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
    if commit:
        con.commit()


def write_corpus(path: Path, docs: Iterable[tuple[str, str, str]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    for p in (path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")):
        p.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    con.executescript(CORPUS)
    n = 0
    batch = []
    for doc_id, title, body in docs:
        batch.append((doc_id, n, title, body))
        n += 1
        if len(batch) == 5000:
            con.executemany("INSERT INTO docs (id, ord, title, body) VALUES (?, ?, ?, ?)", batch)
            batch = []
    con.executemany("INSERT INTO docs (id, ord, title, body) VALUES (?, ?, ?, ?)", batch)
    con.execute("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')")
    con.commit()
    con.close()
    return n
