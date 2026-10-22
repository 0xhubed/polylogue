"""Builds the ledger suite: one generated world per task, at a target reading cost of F × B tokens (spec §4.2, §5; F from the calibration step)."""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

from polyprep import DATA
from polyprep.ledger import GENERATOR_VERSION, generate, prompt
from polyprep.store import open_tasks, put_task, set_meta, write_corpus
from polyprep.tokens import qwen_counter


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--budget", type=int, required=True, help="B for ledger (= B_bcp from P0)")
    ap.add_argument("--seeds", default="1-35")
    ap.add_argument("--pilot", type=int, default=5)
    ap.add_argument("--split-seed", type=int, default=2026)
    ap.add_argument("--factor", type=float, default=2.0, help="reading cost of a world = factor × budget tokens (picked in the calibration step)")
    ap.add_argument("--data-dir", type=Path, help="writes <dir>/ledger/ (default: data/ in the repo)")
    a = ap.parse_args(argv)
    lo_text, _, hi_text = a.seeds.partition("-")
    lo, hi = int(lo_text), int(hi_text or lo_text)
    seeds = list(range(lo, hi + 1))
    if a.factor <= 0:
        ap.error("--factor must be positive")
    count = qwen_counter()
    out = (a.data_dir if a.data_dir is not None else DATA) / "ledger"
    con = open_tasks(out / "tasks.sqlite")
    con.execute("DELETE FROM tasks")
    order = seeds[:]
    random.Random(a.split_seed).shuffle(order)
    pilot = set(order[: a.pilot])
    for seed in seeds:
        w = generate(seed, round(a.factor * a.budget), count)
        tid = f"ledger-{seed:03d}"
        corpus = f"corpus-{tid}.sqlite"
        write_corpus(out / corpus, w.docs)
        put_task(con, id=tid, split="pilot" if seed in pilot else "scored", prompt=prompt(w.question.text), answer=w.question.answer,
                 match=w.question.match, corpus=corpus,
                 info={"generator": GENERATOR_VERSION, "seed": seed, "budget": a.budget, "factor": a.factor, "template": w.question.template, "tokens": w.tokens, "shipments": w.shipments, "attempts": w.attempts, "docs": len(w.docs)})
        print(f"{tid}: template {w.question.template}, {w.shipments} shipments, {len(w.docs)} docs, {w.tokens} tokens")
    set_meta(con, "generator", GENERATOR_VERSION)
    set_meta(con, "budget", str(a.budget))
    set_meta(con, "factor", str(a.factor))
    return 0


if __name__ == "__main__":
    sys.exit(main())
