"""Builds the math suite: post-release contest problems first, generated problems to fill up to 35 (spec §4.3, §5)."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
from pathlib import Path

from polyprep import DATA
from polyprep.mathgen import generated
from polyprep.store import open_tasks, put_task, set_meta
from polyprep.verify import numeric_key


def compose_prompt(problem: str) -> str:
    return ("Solve the problem below. run_python(code) runs Python with sympy and numpy (no network, 10 s per call).\n\n"
            f"Problem: {problem}\n\nThe answer is an integer or a fraction. Claim it in that form.")


def build(pool: list[dict], *, model_release: dt.date, need: int = 35, pilot: int = 5, split_seed: int = 2026, first_seed: int = 1) -> list[dict]:
    seen: set[str] = set()
    for p in pool:
        if p["id"] in seen:
            raise ValueError(f"duplicate pool id {p['id']}")
        seen.add(p["id"])
        if numeric_key(p["answer"]) is None:
            raise ValueError(f"{p['id']}: answer {p['answer']!r} is not an integer or a fraction")
    qualifying = sorted((p for p in pool if dt.date.fromisoformat(p["contest_date"]) > model_release), key=lambda p: p["id"])
    if len(qualifying) > need:
        print(f"warning: {len(qualifying) - need} qualifying contest problems dropped; kept the first {need} by id", file=sys.stderr)
    admitted = qualifying[:need]
    items = [{"id": f"math-{p['id']}", "problem": p["problem"], "answer": p["answer"],
              "info": {"generated": False, "source": p["source"], "number": p["number"], "contest_date": p["contest_date"], "model_release": model_release.isoformat()}}
             for p in admitted]
    seed = first_seed
    while len(items) < need:
        g = generated(seed)
        items.append({"id": f"math-{g['id']}", "problem": g["problem"], "answer": g["answer"], "info": {"generated": True, "kind": g["kind"], "seed": seed}})
        seed += 1
    order = [x["id"] for x in items]
    random.Random(split_seed).shuffle(order)
    pilot_ids = set(order[:pilot])
    return [{"id": x["id"], "split": "pilot" if x["id"] in pilot_ids else "scored", "prompt": compose_prompt(x["problem"]), "answer": x["answer"], "info": x["info"]} for x in items]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pool", type=Path, default=DATA / "math" / "pool.jsonl")
    ap.add_argument("--model-release", required=True, help="Qwen3.8-27B release date from its model card (YYYY-MM-DD)")
    ap.add_argument("--split-seed", type=int, default=2026)
    ap.add_argument("--count", type=int, default=35, help="tasks in the suite (35: 5 pilot, 30 scored)")
    ap.add_argument("--pilot", type=int, default=5, help="how many of them go to the pilot split")
    ap.add_argument("--first-seed", type=int, default=1, help="first generator seed (calibration sets use their own range, e.g. 1001)")
    ap.add_argument("--data-dir", type=Path, default=None, help="write <dir>/math/tasks.sqlite instead of data/ (for a calibration set)")
    a = ap.parse_args(argv)
    data = a.data_dir or DATA
    release = dt.date.fromisoformat(a.model_release)
    pool = [json.loads(l) for l in a.pool.read_text().splitlines() if l.strip()]
    tasks = build(pool, model_release=release, need=a.count, pilot=a.pilot, split_seed=a.split_seed, first_seed=a.first_seed)
    con = open_tasks(data / "math" / "tasks.sqlite")
    try:
        with con:  # one transaction: the old rows, the new rows and the release date land together or not at all
            con.execute("DELETE FROM tasks")
            for t in tasks:
                put_task(con, id=t["id"], split=t["split"], prompt=t["prompt"], answer=t["answer"], match="numeric", info=t["info"], commit=False)
            set_meta(con, "model_release", release.isoformat(), commit=False)
    finally:
        con.close()
    print(f"{sum(not t['info']['generated'] for t in tasks)} contest problems, {sum(t['info']['generated'] for t in tasks)} generated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
