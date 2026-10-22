"""Writes or checks suites/<suite>/frozen.json: task ids, splits, answer hashes and task fingerprints, never answers."""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

from polyprep import DATA, ROOT
from polyprep.verify import answer_hash


# Provenance only: the bcp info also holds the decrypted question and its document ids, which must never reach git.
INFO_KEYS = {
    "bcp": ("query_id",),
    "ledger": ("generator", "seed", "budget", "factor", "template"),
    "math": ("generated", "source", "number", "contest_date", "model_release", "kind", "seed"),
}


def public_info(suite: str, info: dict) -> dict:
    out = {k: info[k] for k in INFO_KEYS[suite] if k in info}
    if suite == "bcp" and "evidence" in info:
        out["n_evidence"] = len(info["evidence"])
    return out


def task_fingerprint(match: str, answer: str, aliases: list[str], prompt: str) -> str:
    """sha256 of match, answer, the aliases sorted by code point and joined by U+0001, and the prompt, separated by U+0000 (UTF-8, hex).
    Mirrored by taskFingerprint in packages/runtime/src/suites/registry.ts; the batch refuses scored tasks whose fingerprint differs from frozen.json."""
    return hashlib.sha256("\x00".join([match, answer, "\x01".join(sorted(aliases)), prompt]).encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def manifest(suite: str, tasks_db: Path) -> dict:
    if not tasks_db.exists():  # sqlite3.connect would create an empty file here
        raise FileNotFoundError(f"{suite}: no task database at {tasks_db}; run the prep step for this suite first")
    con = sqlite3.connect(tasks_db)
    rows = con.execute("SELECT id, split, match, answer, aliases, prompt, corpus, info FROM tasks WHERE split IN ('pilot', 'scored') ORDER BY id").fetchall()
    meta = dict(con.execute("SELECT key, value FROM meta").fetchall())
    con.close()
    tasks = []
    for i, s, m, a, aliases, prompt, corpus, info in rows:
        t = {"id": i, "split": s, "match": m, "answer_sha256": answer_hash(a, m), "task_sha256": task_fingerprint(m, a, json.loads(aliases), prompt)}
        if suite == "ledger":
            path = tasks_db.parent / (corpus or "")
            if not corpus or not path.is_file():
                raise FileNotFoundError(f"ledger task {i}: corpus file {path} is missing")
            t["corpus_sha256"] = file_sha256(path)
        t["info"] = public_info(suite, json.loads(info))
        tasks.append(t)
    out: dict = {"suite": suite}
    if suite == "bcp":
        out["corpus_revision"] = meta.get("corpus_revision")
        out["queries_revision"] = meta.get("queries_revision")
    out["tasks"] = tasks
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("suite", choices=["bcp", "ledger", "math"])
    ap.add_argument("--check", action="store_true", help="compare data/ (tasks, fingerprints, ledger corpora, bcp revisions) against the committed frozen.json")
    a = ap.parse_args(argv)
    try:
        m = manifest(a.suite, DATA / a.suite / "tasks.sqlite")
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 1
    out = ROOT / "suites" / a.suite / "frozen.json"
    if a.check:
        ok = out.exists() and json.loads(out.read_text()) == m
        print(f"{a.suite}: frozen.json {'matches' if ok else 'does NOT match'} data/")
        return 0 if ok else 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out} ({len(m['tasks'])} tasks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
