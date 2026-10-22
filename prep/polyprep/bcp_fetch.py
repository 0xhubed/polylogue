"""Downloads BrowseComp-Plus (pinned revisions), decrypts the questions with the authors' own functions (pinned commit), and builds data/bcp/."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import urllib.request
from collections.abc import Iterable
from pathlib import Path
from types import ModuleType

from polyprep import DATA
from polyprep.bcp import CORPUS_REVISION, DECRYPT_URL, QUERIES_REVISION, compose_prompt, title_of
from polyprep.store import open_tasks, put_task, set_meta, write_corpus

SKIP_KEYS = {"query_id"}  # the authors' script leaves the id in the clear


def load_authors_module(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("bcp_decrypt_dataset", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decrypt_record(module: ModuleType, record: dict) -> dict:
    """One dataset record, decrypted by the pinned script's transform_decrypt with its default canary."""
    return module.transform_decrypt(record, module.DEFAULT_CANARY, SKIP_KEYS)


def store_tasks(con, records: Iterable[dict], doc_ids: set[str], *, force: bool = False) -> int:
    """Writes every decrypted record as a task. Aliases already reviewed in the database are kept, and so are existing `pilot`/`scored`
    splits (a refetch must not undo the screen's selection) unless force=True; every other task is a `candidate`."""
    kept = {tid: json.loads(aliases) for tid, aliases in con.execute("SELECT id, aliases FROM tasks")}
    splits = {} if force else dict(con.execute("SELECT id, split FROM tasks WHERE split IN ('pilot', 'scored')").fetchall())
    count = 0
    for q in records:
        gold = [d["docid"] for d in q["gold_docs"]]
        evidence = [d["docid"] for d in q["evidence_docs"]]
        missing = [d for d in gold + evidence if d not in doc_ids]
        if missing:
            raise SystemExit(f"query {q['query_id']}: documents missing from the corpus: {missing[:5]}")
        tid = f"bcp-{q['query_id']}"
        put_task(con, id=tid, split=splits.get(tid, "candidate"), prompt=compose_prompt(q["query"]), answer=q["answer"], match="contains", aliases=kept.get(tid, ()),
                 corpus="corpus.sqlite", info={"query_id": q["query_id"], "query": q["query"], "gold": gold, "evidence": evidence})
        count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="reset existing pilot/scored splits to candidate (they are kept by default)")
    a = ap.parse_args(argv)
    from datasets import load_dataset

    raw = DATA / "bcp" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    script = raw / "decrypt_dataset.py"
    urllib.request.urlretrieve(DECRYPT_URL, script)
    authors = load_authors_module(script)
    records = [decrypt_record(authors, dict(r)) for r in load_dataset("Tevatron/browsecomp-plus", split="test", revision=QUERIES_REVISION)]

    corpus = load_dataset("Tevatron/browsecomp-plus-corpus", split="train", revision=CORPUS_REVISION)
    ids: set[str] = set()

    def docs():
        for r in corpus:
            ids.add(r["docid"])
            yield r["docid"], title_of(r["text"], r["url"] or ""), r["text"]

    n = write_corpus(DATA / "bcp" / "corpus.sqlite", docs())
    con = open_tasks(DATA / "bcp" / "tasks.sqlite")
    count = store_tasks(con, records, ids, force=a.force)
    set_meta(con, "queries_revision", QUERIES_REVISION)
    set_meta(con, "corpus_revision", CORPUS_REVISION)
    print(f"corpus: {n} documents; questions: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
