import datetime as dt
import json
import random
import re
import sqlite3

import pytest

from polyprep import math_build
from polyprep import mathgen as mg
from polyprep.math_build import build, main
from polyprep.mathgen import KINDS, generated
from polyprep.verify import numeric_key

POOL = [
    {"id": f"aime2026-1-{n:02d}", "source": "AIME 2026 I", "contest_date": "2026-02-05", "number": n, "problem": f"P{n}", "answer": str(n * 7)} for n in range(8, 16)
] + [
    {"id": f"old-{n}", "source": "AIME 2025 I", "contest_date": "2025-02-06", "number": n, "problem": "old", "answer": "1"} for n in range(8, 16)
]


def test_generated_problems_are_deterministic_and_checked():
    for seed in range(1, 7):
        g = generated(seed)
        assert g == generated(seed)
        assert numeric_key(g["answer"]) is not None
    assert {generated(s)["kind"] for s in range(1, 7)} == set(KINDS)


def test_generated_answers_are_at_least_ten():
    for seed in range(1, 7):
        assert int(generated(seed)["answer"]) >= 10


@pytest.mark.parametrize("seed", range(6))
def test_fast_solvers_agree_with_brute_force_on_small_inputs(seed):
    rng = random.Random(seed)
    for _ in range(8):
        n = rng.randint(1, 300)
        assert mg.totient_sum_fast(n) == mg.totient_sum_brute(n)
        n = rng.randint(1, 20000)
        assert mg.prime_sum_fast(n) == mg.prime_sum_brute(n)
        n = rng.randint(1, 20000)
        assert mg.squarefree_count_fast(n) == mg.squarefree_count_brute(n)
        a, b = sorted((rng.randint(1, 120), rng.randint(1, 120)))
        assert mg.coprime_pairs_fast(a, b) == mg.coprime_pairs_brute(a, b)
        n = rng.randint(0, 5000)
        assert mg.circle_points_fast(n) == mg.circle_points_brute(n)
        n, primes, k = rng.randint(1, 3000), sorted(rng.sample(mg.PRIMES, rng.randint(0, 4))), rng.randint(1, 40)
        r = rng.randint(0, k - 1)
        assert mg.coprime_count_fast(n, primes, k, r) == mg.coprime_count_brute(n, primes, k, r)


def test_published_values():
    """The sublinear paths at sizes the brute-force check cannot reach, against values published elsewhere."""
    assert mg.prime_sum_fast(10 ** 10) == 2220822432581729238 % mg.MOD  # sum of primes below 1e10
    assert mg.totient_sum_fast(10 ** 9) == 303963551173008414 % mg.MOD  # sum of phi(n), n <= 1e9
    assert mg.squarefree_count_fast(10 ** 12) == 607927102274
    assert [mg.circle_points_fast((10 ** k) ** 2) for k in (3, 4, 7)] == [3141549, 314159053, 314159265350589]  # Gauss circle problem
    assert mg.coprime_pairs_fast(10 ** 6, 10 ** 6) == (2 * int(mg._phi_to(10 ** 6)[1:].sum()) - 1) % mg.MOD


def test_generated_sizes_rule_out_a_plain_loop():
    lower = {"totient_sum": 10 ** 10, "prime_sum": 10 ** 10, "squarefree_count": 10 ** 14, "circle_points": 10 ** 14, "coprime_count": 10 ** 12, "coprime_pairs": 10 ** 10}
    for seed in range(1, 7):
        g = generated(seed)
        assert int(re.search(r"\d{6,}", g["problem"]).group()) >= lower[g["kind"]], g["id"]  # the first long number is N (or A)


@pytest.fixture
def cheap_generated(monkeypatch):
    """build() and the CLI only place generated problems; solving the real ones takes seconds each."""
    fake = lambda seed: {"id": f"gen-{seed:03d}", "problem": f"G{seed}", "answer": str(100 + seed), "kind": KINDS[seed % len(KINDS)]}
    monkeypatch.setattr(math_build, "generated", fake)


def test_build_admits_only_contests_after_release_and_fills_with_generated(cheap_generated):
    tasks = build(POOL, model_release=dt.date(2025, 12, 1), need=35, pilot=5, split_seed=2026)
    assert len(tasks) == 35
    contest = [t for t in tasks if not t["info"]["generated"]]
    assert {t["info"]["source"] for t in contest} == {"AIME 2026 I"} and len(contest) == 8
    assert sum(1 for t in tasks if t["split"] == "pilot") == 5
    assert all(t["prompt"].startswith("Solve the problem below.") and t["prompt"].endswith("Claim it in that form.") for t in tasks)
    assert build(POOL, model_release=dt.date(2025, 12, 1), need=35, pilot=5, split_seed=2026) == tasks


def test_contest_dated_on_release_day_is_excluded(cheap_generated):
    day = dt.date(2025, 12, 1)
    pool = [dict(POOL[0], id="on-release-day", contest_date="2025-12-01"), dict(POOL[0], id="day-after", contest_date="2025-12-02")]
    tasks = build(pool, model_release=day, need=2, pilot=0, split_seed=1)
    assert [t["id"] for t in tasks if not t["info"]["generated"]] == ["math-day-after"]


def test_build_rejects_non_numeric_answers():
    bad = [dict(POOL[0], answer="x^2 + 1")]
    with pytest.raises(ValueError, match="aime2026-1-08"):
        build(bad, model_release=dt.date(2025, 1, 1), need=1, pilot=0, split_seed=1)


def test_build_refuses_duplicate_pool_ids():
    with pytest.raises(ValueError, match="duplicate pool id aime2026-1-08"):
        build([POOL[0], dict(POOL[0])], model_release=dt.date(2025, 1, 1), need=1, pilot=0, split_seed=1)


def test_extra_contest_problems_are_dropped_by_id_with_a_warning(capsys, cheap_generated):
    tasks = build(POOL, model_release=dt.date(2025, 12, 1), need=5, pilot=0, split_seed=1)
    assert [t["info"]["number"] for t in tasks if not t["info"]["generated"]] == [8, 9, 10, 11, 12]
    assert "3 qualifying contest problems dropped" in capsys.readouterr().err


def test_cli_replaces_tasks_and_records_release_in_one_pass(tmp_path, monkeypatch, cheap_generated):
    monkeypatch.setattr(math_build, "DATA", tmp_path)
    pool = tmp_path / "pool.jsonl"
    pool.write_text("\n".join(json.dumps(p) for p in POOL) + "\n")
    assert main(["--pool", str(pool), "--model-release", "2025-12-01"]) == 0
    assert main(["--pool", str(pool), "--model-release", "2025-12-01"]) == 0  # a rerun replaces the rows, it does not append
    con = sqlite3.connect(tmp_path / "math" / "tasks.sqlite")
    try:
        assert con.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 35
        assert con.execute("SELECT value FROM meta WHERE key = 'model_release'").fetchone()[0] == "2025-12-01"
    finally:
        con.close()


def test_cli_builds_a_calibration_set_in_another_data_dir(tmp_path, cheap_generated):
    pool = tmp_path / "pool.jsonl"
    pool.write_text("")
    assert main(["--pool", str(pool), "--model-release", "2026-08-05", "--count", "12", "--pilot", "12", "--first-seed", "1001", "--data-dir", str(tmp_path / "calib")]) == 0
    con = sqlite3.connect(tmp_path / "calib" / "math" / "tasks.sqlite")
    try:
        assert con.execute("SELECT split, COUNT(*) FROM tasks GROUP BY split").fetchall() == [("pilot", 12)]
        infos = [json.loads(i) for (i,) in con.execute("SELECT info FROM tasks")]
        assert {i["kind"] for i in infos} == set(KINDS) and min(i["seed"] for i in infos) == 1001
    finally:
        con.close()
