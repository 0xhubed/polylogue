"""Oracle screen: keep the questions the pinned model answers when handed the gold documents; then select 35 by evidence spread."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from polyprep import DATA
from polyprep.bcp import ORACLE_CHARS, fit_docs, oracle_messages, select
from polyprep.model import SAMPLING, chat, check_server
from polyprep.store import set_meta
from polyprep.verify import verify_claim

SCREEN_DDL = """CREATE TABLE IF NOT EXISTS screen (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok', 'infra')),
  passed INTEGER NOT NULL,
  claim TEXT NOT NULL,
  detail TEXT,
  finish_reason TEXT,
  prompt_chars INTEGER,
  truncated INTEGER,
  ms INTEGER NOT NULL,
  tokens INTEGER NOT NULL
)"""
CLAIM_CHARS = 2000
INFRA_ERRORS = (RuntimeError, OSError, KeyError)


def _cell(text: str, n: int = 300) -> str:
    return text.replace("|", "/").replace("\n", " ")[:n]


INSERT_ROW = ("INSERT OR REPLACE INTO screen (task_id, status, passed, claim, detail, finish_reason, prompt_chars, truncated, ms, tokens) "
              "VALUES (:task_id, :status, :passed, :claim, :detail, :finish_reason, :prompt_chars, :truncated, :ms, :tokens)")


def screen(data: Path, *, server, model_id, hf_repo, concurrency, max_tokens, reasoning, seed, take=35, pilot=5, split_seed=2026, limit=None,
           reselect=False, after_row=None) -> dict:
    """Screens the unscreened tasks, re-verifies every screened claim, and selects — unless a selection (pilot/scored splits) already exists
    and reselect is False: then only the screen rows are updated. On Ctrl-C: queued calls are cancelled, finished rows kept, no selection.
    after_row(n) is called after the n-th row of this run is committed (a test hook)."""
    check_server(server, model_id, hf_repo)
    con = sqlite3.connect(data / "bcp" / "tasks.sqlite")
    con.execute(SCREEN_DDL)
    config = json.dumps({"model_id": model_id, "seed": seed, "reasoning": reasoning, "max_tokens": max_tokens, "oracle_chars": ORACLE_CHARS, "sampling": SAMPLING}, sort_keys=True)
    prior = con.execute("SELECT value FROM meta WHERE key = 'screen_config'").fetchone()
    if prior and prior[0] != config:
        raise RuntimeError(f"data/bcp was screened with {prior[0]}; this run uses {config}. Delete the screen table and the screen_config meta row to start over.")
    set_meta(con, "screen_config", config)
    corpus_path = data / "bcp" / "corpus.sqlite"
    rows = con.execute("SELECT id, answer, aliases, match, info FROM tasks WHERE id NOT IN (SELECT task_id FROM screen WHERE status = 'ok') ORDER BY id").fetchall()
    if limit is not None:
        rows = rows[:limit]

    def one(row):
        tid, answer, aliases, match, info = row
        t0 = time.monotonic()
        out = {"task_id": tid, "status": "infra", "passed": 0, "claim": "", "detail": None, "finish_reason": None, "prompt_chars": 0, "truncated": 0, "tokens": 0}
        try:
            info = json.loads(info)
            with closing(sqlite3.connect(corpus_path)) as c:
                gold = [g for g in (c.execute("SELECT id, title, body FROM docs WHERE id = ?", (d,)).fetchone() for d in info["gold"]) if g]
            if not gold:
                raise KeyError("none of the gold documents is in the corpus")
            messages = oracle_messages(info["query"], gold)
            out["prompt_chars"] = len(messages[1]["content"])
            out["truncated"] = int(fit_docs(gold)[1])
            r = chat(server, model_id, messages, seed=seed, max_tokens=max_tokens, reasoning_effort=reasoning)
            ok, detail = verify_claim(answer, json.loads(aliases), match, r["content"])
            out.update(status="ok", passed=int(ok), claim=r["content"].strip()[:CLAIM_CHARS], detail=detail, finish_reason=r["finish_reason"],
                       tokens=int(r["usage"].get("prompt_tokens", 0)) + int(r["usage"].get("completion_tokens", 0)))
        except INFRA_ERRORS as e:
            out["detail"] = f"{type(e).__name__}: {e}"[:500]
        out["ms"] = round((time.monotonic() - t0) * 1000)
        return out

    pool = ThreadPoolExecutor(concurrency)
    futures = [pool.submit(one, r) for r in rows]
    kept: set = set()
    try:
        for fut in as_completed(futures):
            con.execute(INSERT_ROW, fut.result())
            con.commit()
            kept.add(fut)
            if after_row:
                after_row(len(kept))
    except KeyboardInterrupt:
        pool.shutdown(wait=True, cancel_futures=True)  # queued calls never start; the ones in flight finish
        for fut in futures:  # keep what the calls in flight returned
            if fut not in kept and fut.done() and not fut.cancelled() and fut.exception() is None:
                con.execute(INSERT_ROW, fut.result())
                kept.add(fut)
        con.commit()
        con.close()
        print(f"interrupted: {len(kept)} tasks screened in this run and kept, {len(rows) - len(kept)} not screened; no selection made. Run again to resume.")
        return {"interrupted": True, "screened": len(kept), "not_screened": len(rows) - len(kept)}
    finally:
        pool.shutdown(wait=True, cancel_futures=True)  # also on any other error; a no-op once all calls are done

    with con:  # one transaction: re-verify with the current answers and aliases, reset the splits, assign the selection
        for tid, claim, answer, aliases, match in con.execute(
                "SELECT s.task_id, s.claim, t.answer, t.aliases, t.match FROM screen s JOIN tasks t ON t.id = s.task_id WHERE s.status = 'ok'").fetchall():
            ok, detail = verify_claim(answer, json.loads(aliases), match, claim)
            con.execute("UPDATE screen SET passed = ?, detail = ? WHERE task_id = ?", (int(ok), detail, tid))
        screened = [(tid, bool(p), len(json.loads(info)["evidence"]))
                    for tid, p, info in con.execute("SELECT s.task_id, s.passed, t.info FROM screen s JOIN tasks t ON t.id = s.task_id WHERE s.status = 'ok'")]
        existing = dict(con.execute("SELECT id, split FROM tasks WHERE split IN ('pilot', 'scored')").fetchall())
        if existing and not reselect:
            chosen = existing
            print(f"kept the existing selection ({len(existing)} tasks); run with --reselect to recompute it from the screen")
        else:
            chosen = select(screened, take=take, pilot=pilot, seed=split_seed)
            con.execute("UPDATE tasks SET split = 'candidate'")
            for tid, split in chosen.items():
                con.execute("UPDATE tasks SET split = ? WHERE id = ?", (split, tid))

    passed = sum(1 for x in screened if x[1])
    infra = con.execute("SELECT COUNT(*) FROM screen WHERE status = 'infra'").fetchone()[0]
    if passed < take:
        print(f"warning: only {passed} tasks passed the screen, fewer than the {take} to select ({infra} not screened because of errors)")
    failures = con.execute("SELECT s.task_id, t.answer, s.claim FROM screen s JOIN tasks t ON t.id = s.task_id WHERE s.status = 'ok' AND s.passed = 0 ORDER BY s.task_id").fetchall()
    errors = con.execute("SELECT task_id, detail FROM screen WHERE status = 'infra' ORDER BY task_id").fetchall()
    lines = ["# Oracle screen failures (for alias review; contains answers, stays in data/)", "", "| task | answer | model said |", "|---|---|---|"]
    lines += [f"| {t} | {_cell(a)} | {_cell(c)} |" for t, a, c in failures]
    if errors:
        lines += ["", "## Not screened (errors; retried on the next run)", "", "| task | error |", "|---|---|"]
        lines += [f"| {t} | {_cell(d or '')} |" for t, d in errors]
    (data / "bcp" / "screen-failures.md").write_text("\n".join(lines) + "\n")
    con.close()
    return {"screened": len(screened), "passed": passed, "selected": len(chosen), "infra": infra}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", required=True)
    ap.add_argument("--model-id", default="qwen3.8-27b")
    ap.add_argument("--hf-repo", default="unsloth/Qwen3.8-27B-NVFP4")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=32768)
    ap.add_argument("--reasoning", default="medium")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--reselect", action="store_true", help="recompute the selection even if pilot/scored splits exist (kept by default)")
    a = ap.parse_args(argv)
    try:
        out = screen(DATA, server=a.server, model_id=a.model_id, hf_repo=a.hf_repo, concurrency=a.concurrency, max_tokens=a.max_tokens, reasoning=a.reasoning,
                     seed=a.seed, limit=a.limit, reselect=a.reselect)
    except KeyboardInterrupt:  # before or after the calls (server check, selection): nothing half-written to keep
        print("interrupted")
        return 130
    print(out)
    return 130 if out.get("interrupted") else 0


if __name__ == "__main__":
    sys.exit(main())
