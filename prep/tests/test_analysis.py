import os
import json
import sqlite3
from pathlib import Path

import pytest

from polyprep import ROOT
from polyprep import analysis as an

DDL = """
CREATE TABLE runs (id TEXT PRIMARY KEY, condition TEXT NOT NULL, n INTEGER NOT NULL, task_id TEXT NOT NULL, seed INTEGER NOT NULL,
  model TEXT NOT NULL, revision TEXT NOT NULL, sampling TEXT NOT NULL, config_hash TEXT NOT NULL, git_sha TEXT,
  status TEXT NOT NULL, end_reason TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq));
"""


def mklog(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.executescript(DDL)
    return con


def add_run(con, run_id, condition, task, seed, events, *, fingerprint="fp", status=None):
    n = 1 if condition == "single" else 4
    end = next((e for e in events if e["kind"] == "run_finished"), None)
    st = status or ("solved" if end and end["solved"] else "infra_error" if end and end["reason"] == "infra_error" else "unsolved")
    con.execute("INSERT INTO runs VALUES (?,?,?,?,?,'m','r','{}','h',NULL,?,?,'2026-10-17T00:00:00Z','2026-10-17T00:10:00Z')",
                (run_id, condition, n, task, seed, st, end["reason"] if end else None))
    full = [{"kind": "run_started", "t": 0, "condition": condition, "n": n, "taskId": task, "task": "q", "pool": 1, "wallClockMs": 1, "taskFingerprint": fingerprint}] + events
    for i, e in enumerate(full):
        con.execute("INSERT INTO events VALUES (?,?,?,?,?)", (run_id, i, e["t"], e["kind"], json.dumps(e)))
    con.commit()


def finished(t, reason, solved, tokens=100):
    return {"kind": "run_finished", "t": t, "reason": reason, "solved": solved, "wallMs": t, "totalTokens": tokens}


def claim(t, agent, answer, passed):
    return [{"kind": "claim_submitted", "t": t, "agent": agent, "answer": answer, "evidence": "e"},
            {"kind": "verification", "t": t, "claimOf": agent, "passed": passed}]


# --- statistics ---

def test_mcnemar_exact():
    assert an.mcnemar(0, 0) == 1.0
    assert an.mcnemar(8, 2) == pytest.approx(112 / 1024)
    assert an.mcnemar(2, 8) == pytest.approx(112 / 1024)
    assert an.mcnemar(10, 0) == pytest.approx(2 / 1024)


def test_holm():
    assert an.holm([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.06, 0.06])
    assert an.holm([0.5, 0.9]) == pytest.approx([1.0, 1.0])


def test_wilcoxon_one_sided_less():
    assert an.wilcoxon_less([-1.0, -2.0, -3.0]) == pytest.approx(1 / 8)
    assert an.wilcoxon_less([1.0, 2.0, 3.0]) == pytest.approx(1.0)


def test_bootstrap_is_deterministic_and_centred():
    pairs = {f"t{i}": [(1, 0), (1, 1)] if i % 2 else [(0, 0), (1, 0)] for i in range(30)}
    a = an.paired_diff(pairs)
    b = an.paired_diff(pairs)
    assert a == b
    assert a["effect"] == pytest.approx(50.0)  # A solves 45 of 60 pairs, B 15 of 60: 75% - 25%
    assert a["lo"] <= a["effect"] <= a["hi"]


# --- verdict rules, including the boundaries ---

@pytest.mark.parametrize("h2,par,verdict", [
    ((10.0, 0.1, 20.0), (0.0, -5.0, 5.0), "TALK HELPS"),
    ((10.0, 0.0, 20.0), (0.0, -5.0, 5.0), "NO GAIN"),          # interval touches 0: not excluded
    ((9.9, 1.0, 20.0), (10.0, 0.5, 20.0), "ONLY PARALLELISM"),
    ((9.9, 1.0, 20.0), (10.0, -0.5, 20.0), "NO GAIN"),
    ((15.0, -2.0, 30.0), (12.0, 2.0, 22.0), "ONLY PARALLELISM"),
    ((-12.0, -20.0, -3.0), (0.0, -5.0, 5.0), "NO GAIN"),       # an interval below 0 does not count as a gain
])
def test_h2_verdict(h2, par, verdict):
    e, lo, hi = h2
    pe, plo, phi = par
    assert an.h2_verdict({"effect": e, "lo": lo, "hi": hi}, {"effect": pe, "lo": plo, "hi": phi}) == verdict


# --- event-log metrics ---

def msg(t, mid, frm, recipients, text):
    return {"kind": "message", "t": t, "id": mid, "from": frm, "to": {"topic": "all"}, "recipients": recipients, "text": text, "urgent": False}


def delivered(t, agent, mid):
    return {"kind": "message_delivered", "t": t, "agent": agent, "messageId": mid, "delivery": 0}


def call(t, agent, tools):
    return {"kind": "model_call", "t": t, "agent": agent, "call": 0, "content": "", "reasoning": "", "toolCalls": [{"id": "x", "name": n, "args": a} for n, a in tools],
            "tokensIn": 1, "tokensOut": 1, "ms": 1, "stopReason": "toolUse"}


def test_substantive_message_needs_a_match_in_the_receivers_next_three_calls():
    base = [msg(5, "m0", "a1", ["a2"], 'Doc 32615 mentions "Blue Lagoon" and Amani Kilonzo Wekesa.'), delivered(10, "a2", "m0")]
    hit = base + [call(20, "a2", [("read_doc", {"id": "32615"})])]
    assert an.substantive_messages(hit) == {"m0"}
    entity = base + [call(20, "a2", [("search", {"query": "amani kilonzo wekesa biography"})])]
    assert an.substantive_messages(entity) == {"m0"}
    quoted = base + [call(20, "a2", [("search", {"query": "blue lagoon"})])]
    assert an.substantive_messages(quoted) == {"m0"}
    late = base + [call(20 + i, "a2", [("search", {"query": "nothing"})]) for i in range(3)] + [call(30, "a2", [("read_doc", {"id": "32615"})])]
    assert an.substantive_messages(late) == set()
    before = [msg(5, "m0", "a1", ["a2"], "Doc 32615."), call(7, "a2", [("read_doc", {"id": "32615"})]), delivered(10, "a2", "m0")]
    assert an.substantive_messages(before) == set()
    own = [msg(5, "m0", "a1", ["a2"], "Doc 32615."), delivered(10, "a2", "m0"), call(20, "a1", [("read_doc", {"id": "32615"})])]
    assert an.substantive_messages(own) == set()


def test_items_from_the_task_itself_do_not_make_a_message_substantive():
    task = {"kind": "run_started", "t": 0, "condition": "polylogue", "n": 4, "taskId": "t", "task": "Which series from 2010 starred Amani Kilonzo Wekesa?", "pool": 1, "wallClockMs": 1}
    ev = [task, msg(5, "m0", "a1", ["a2"], "I'll search 2010 series with Amani Kilonzo Wekesa."), delivered(10, "a2", "m0"),
          call(20, "a2", [("search", {"query": "2010 series amani kilonzo wekesa"})])]
    assert an.substantive_messages(ev) == set()
    ev2 = ev[:2] + [msg(6, "m1", "a1", ["a2"], "Doc 32615 has it."), delivered(10, "a2", "m1"), call(20, "a2", [("read_doc", {"id": "32615"})])]
    assert an.substantive_messages(ev2) == {"m1"}


def test_the_pronoun_i_is_not_part_of_a_name():
    assert an._entities("Now I agree with Amani Kilonzo Wekesa.") == {"amani kilonzo wekesa"}


def test_numbers_match_as_numbers():
    ev = [msg(5, "m0", "a1", ["a2"], "The total is 1,500 units"), delivered(10, "a2", "m0"), call(20, "a2", [("run_python", {"code": "print(1500.0)"})])]
    assert an.substantive_messages(ev) == {"m0"}


def test_duplicate_work():
    reads = []
    for i, (agent, doc, err) in enumerate([("a1", "d1", False), ("a2", "d1", False), ("a1", "d2", False), ("a3", "d3", True), ("a2", "d3", False)]):
        reads += [{"kind": "tool_call", "t": i, "agent": agent, "callId": f"c{i}", "tool": "read_doc", "args": {"id": doc}},
                  {"kind": "tool_result", "t": i, "agent": agent, "callId": f"c{i}", "tool": "read_doc", "isError": err, "text": "", "ms": 1}]
    assert an.duplicate_reads(reads) == (1, 3)  # d1 read by two agents; d3's first read failed
    code = [("a1", "x = 1  # set\nprint(x)"), ("a1", "x=1\nprint(x)"), ("a2", "x=1\nprint(x)  # again"), ("a3", "print(2)")]
    py = [{"kind": "tool_call", "t": i, "agent": a, "callId": f"p{i}", "tool": "run_python", "args": {"code": c}} for i, (a, c) in enumerate(code)]
    assert an.duplicate_python(py) == (1, 4)  # a2 repeats a1; a1 repeating itself is not duplicate work


def test_wrong_consensus_and_idle_time():
    ev = [{"kind": "blackboard", "t": 5, "agent": "a1", "text": "I think it is Lyon."}] + claim(9, "a2", "Lyon", False)
    assert an.wrong_consensus(ev) == 1
    assert an.wrong_consensus(claim(9, "a2", "Lyon", False)) == 0
    idle = [{"kind": "idle", "t": 10, "agent": "a1"}, {"kind": "wake", "t": 25, "agent": "a1", "reason": "message"}, {"kind": "idle", "t": 30, "agent": "a1"}, finished(50, "all_idle", False)]
    assert an.idle_ms(idle) == {"a1": 35}


# --- loading, gates, scores ---

def matrix(tmp_path, conditions=("single", "isolated"), seeds=(1,), suites=("bcp",)):
    m = {"name": "t", "orderSeed": 1, "dataDir": "data", "servers": ["http://x/v1"], "conditions": list(conditions), "seeds": list(seeds),
         "suites": [{"suite": s, "split": "scored", "tokensPerAgent": 1, "wallClockMs": 1} for s in suites], "rate": {"messagesPerMinute": 1, "maxMessageChars": 1},
         "model": {}}
    p = tmp_path / "m.json"
    p.write_text(json.dumps(m))
    return p


def frozen(tmp_path, ids=("bcp-1", "bcp-2"), suite="bcp"):
    d = tmp_path / "suites" / suite
    d.mkdir(parents=True)
    (d / "frozen.json").write_text(json.dumps({"suite": suite, "tasks": [{"id": i, "split": "scored", "task_sha256": "fp"} for i in ids]}))
    return tmp_path / "suites"


def test_scores_isolated_by_first_claim_and_best_of_n_and_uses_the_rerun(tmp_path):
    con = mklog(tmp_path / "r.sqlite")
    add_run(con, "bcp-bcp-1-single-s1", "single", "bcp-1", 1, claim(5, "a1", "x", True) + [finished(6, "solved", True)])
    add_run(con, "bcp-bcp-2-single-s1", "single", "bcp-2", 1, [finished(6, "infra_error", False)])
    add_run(con, "bcp-bcp-2-single-s1-r1", "single", "bcp-2", 1, claim(5, "a1", "y", False) + [finished(6, "wrong_claim", False)])
    add_run(con, "bcp-bcp-1-isolated-s1", "isolated", "bcp-1", 1, claim(5, "a1", "no", False) + claim(8, "a2", "x", True) + [finished(9, "solved", True)])
    add_run(con, "bcp-bcp-2-isolated-s1", "isolated", "bcp-2", 1, claim(5, "a3", "y", True) + [finished(6, "solved", True)])
    runs = an.load(tmp_path / "r.sqlite", matrix(tmp_path), frozen(tmp_path))
    by = {(r.condition, r.task): r for r in runs}
    assert (by[("isolated", "bcp-1")].first, by[("isolated", "bcp-1")].best) == (False, True)
    assert (by[("isolated", "bcp-2")].first, by[("isolated", "bcp-2")].first_pass_t) == (True, 5)
    assert by[("single", "bcp-2")].run_id.endswith("-r1") and by[("single", "bcp-2")].first is False


def test_completeness_and_fingerprint_gates(tmp_path):
    con = mklog(tmp_path / "r.sqlite")
    add_run(con, "bcp-bcp-1-single-s1", "single", "bcp-1", 1, [finished(6, "budget", False)])
    m, f = matrix(tmp_path), frozen(tmp_path)
    with pytest.raises(an.Incomplete, match="3 of 4 cells missing"):
        an.load(tmp_path / "r.sqlite", m, f)
    assert len(an.load(tmp_path / "r.sqlite", m, f, allow_incomplete=True)) == 1
    add_run(con, "bcp-bcp-2-single-s1", "single", "bcp-2", 1, [finished(6, "budget", False)], fingerprint="other")
    with pytest.raises(an.FingerprintMismatch, match="bcp-bcp-2-single-s1"):
        an.load(tmp_path / "r.sqlite", m, f, allow_incomplete=True)


def test_report_without_verdicts_on_incomplete_data(tmp_path):
    con = mklog(tmp_path / "r.sqlite")
    add_run(con, "bcp-bcp-1-single-s1", "single", "bcp-1", 1, claim(5, "a1", "x", True) + [finished(6, "solved", True)])
    md, data = an.analyse(tmp_path / "r.sqlite", matrix(tmp_path), frozen(tmp_path), allow_incomplete=True)
    assert "INCOMPLETE" in md and "verdict" not in data
    assert data["solve"]["bcp"]["single"] == {"runs": 1, "first": 1, "solved": 1}


PILOT = ROOT / "data" / "pilot-p1b.sqlite"


@pytest.mark.skipif(not PILOT.exists(), reason="pilot data is local (data/ is git-ignored)")
def test_reproduces_the_p1b_pilot_counts():
    _, data = an.analyse(PILOT, ROOT / "configs" / "pilot-p1b.json", ROOT / "suites", allow_incomplete=True)
    bcp = {c: v["first"] for c, v in data["solve"]["bcp"].items()}
    assert bcp == {"single": 1, "isolated": 5, "stigmergic": 6, "polylogue": 6, "polylogue-bare": 4}
    assert {c: v["first"] for c, v in data["solve"]["math"].items()} == {"single": 2, "isolated": 3, "stigmergic": 4, "polylogue": 4, "polylogue-bare": 4}


# --- phase 2: forking (docs/superpowers/specs/2026-10-22-polylogue-phase2-fork-design.md §5) ---

@pytest.mark.parametrize("d,verdict", [
    ((10.0, 0.1, 20.0), "FORKING HELPS"),
    ((10.0, 0.0, 20.0), "NO GAIN"),       # interval touches 0: not excluded
    ((9.9, 1.0, 20.0), "NO GAIN"),        # below the 10-point bar
    ((-12.0, -20.0, -0.1), "FORKING HURTS"),
    ((-12.0, -20.0, 0.0), "NO GAIN"),     # interval touches 0: not entirely below it
    ((-3.0, -6.0, -1.0), "FORKING HURTS"),  # HURTS has no size bar, only the interval
])
def test_fork_verdict(d, verdict):
    e, lo, hi = d
    assert an.fork_verdict({"effect": e, "lo": lo, "hi": hi}) == verdict


@pytest.mark.parametrize("d,verdict", [
    ((10.0, 0.1, 20.0), "TALK ADDS"),
    ((10.0, 0.0, 20.0), "NO GAIN"),
    ((9.9, 1.0, 20.0), "NO GAIN"),
    ((-12.0, -20.0, -0.1), "NO GAIN"),    # talk hurting is not a separate verdict
])
def test_talk_verdict(d, verdict):
    e, lo, hi = d
    assert an.talk_verdict({"effect": e, "lo": lo, "hi": hi}) == verdict


def fork_ev(t, directions=("Clue one", "Clue two", "Clue three"), fallback=False):
    return {"kind": "fork", "t": t, "agent": "a1", "call": 3, "children": ["a2", "a3", "a4"], "directions": list(directions), "fallback": fallback}


def read(t, agent, doc, cid, err=False):
    return [{"kind": "tool_call", "t": t, "agent": agent, "callId": cid, "tool": "read_doc", "args": {"id": doc}},
            {"kind": "tool_result", "t": t, "agent": agent, "callId": cid, "tool": "read_doc", "isError": err, "text": "", "ms": 1}]


def py(t, agent, code, cid):
    return [{"kind": "tool_call", "t": t, "agent": agent, "callId": cid, "tool": "run_python", "args": {"code": code}}]


def test_post_fork_duplicates_count_reads_of_documents_the_root_read_before_the_fork():
    ev = (read(1, "a1", "d1", "c1") + read(2, "a1", "d2", "c2") + read(3, "a1", "d9", "c3", err=True) + read(10, "a1", "d6", "c4")
          + [fork_ev(10)]
          + read(11, "a2", "d1", "c5")     # inherited from the root: a duplicate
          + read(12, "a3", "d4", "c6") + read(13, "a4", "d4", "c7")  # two copies: a duplicate
          + read(14, "a1", "d2", "c8")     # the root re-reading its own document: not a duplicate
          + read(15, "a2", "d9", "c9"))    # the root's read of d9 failed: not a duplicate
    assert an.post_fork_duplicate_reads(ev) == (2, 4)  # documents read after the fork: d1, d4, d2, d9
    assert an.duplicate_reads(ev) == (2, 5)            # the whole run also has d6 (root, before the fork only)
    code = (py(1, "a1", "x=1", "p1") + [fork_ev(5)] + py(6, "a1", "x=1", "p2") + py(7, "a2", "x = 1  # again", "p3")
            + py(8, "a3", "y=2", "p4") + py(9, "a4", "y=2", "p5"))
    assert an.post_fork_duplicate_python(code) == (2, 4)  # the root repeating itself is not; a2 repeats the root's pre-fork code, a4 repeats a3
    assert an.duplicate_python(code) == (2, 5)
    assert an.post_fork_duplicate_reads(read(1, "a1", "d1", "c1")) is None  # no fork: no post-fork share
    assert an.post_fork_duplicate_python(py(1, "a1", "x=1", "p1")) is None


def test_fork_stats_of_a_run():
    assert an.fork_stats(read(1, "a1", "d1", "c1")) == {"forked": False, "fallback": False, "distinct": False, "max_jaccard": None}
    assert an.fork_stats([fork_ev(5)]) == {"forked": True, "fallback": False, "distinct": True, "max_jaccard": pytest.approx(1 / 3)}  # "clue" shared, 3 words in the union
    assert an.fork_stats([fork_ev(5, ("Clue A", " clue a", "Other"))]) == {"forked": True, "fallback": False, "distinct": False, "max_jaccard": 1.0}
    generic = ("Take a different approach from your siblings.",) * 3
    assert an.fork_stats([fork_ev(5, generic, fallback=True)]) == {"forked": True, "fallback": True, "distinct": False, "max_jaccard": 1.0}


def test_max_pairwise_jaccard_matches_the_report_measure():
    assert an.max_pairwise_jaccard(["a b c", "A, b; c!", "x y"]) == 1
    assert an.max_pairwise_jaccard(["a b", "c d", "e f"]) == 0
    assert an.max_pairwise_jaccard(["the cat sat", "the cat ran", "dog"]) == pytest.approx(0.5)
    assert an.max_pairwise_jaccard(["Doc 42", "doc 42 again", "Ghent"]) == pytest.approx(2 / 3)
    assert an.max_pairwise_jaccard(["snake_case word", "snake case word", "x"]) == 1  # an underscore splits, as in the report


def phase2_log(tmp_path):
    con = mklog(tmp_path / "r.sqlite")
    runs = {
        ("bcp", "bcp-1", "fork"): read(1, "a1", "d1", "c1") + [fork_ev(5)] + read(6, "a2", "d1", "c2") + read(7, "a3", "d2", "c3")
                                  + claim(8, "a2", "x", True) + [finished(9, "solved", True, tokens=300)],
        ("bcp", "bcp-2", "fork"): read(1, "a1", "d1", "c1") + [finished(9, "budget", False, tokens=400)],  # ended before the fork
        ("bcp", "bcp-1", "fork-silent"): [fork_ev(5, ("Take a different approach from your siblings.",) * 3, fallback=True)]
                                         + claim(8, "a2", "y", False) + [finished(9, "wrong_claim", False)],
        ("bcp", "bcp-2", "fork-silent"): [fork_ev(5, ("Clue A", " clue a", "Other"))] + claim(8, "a3", "x", True) + [finished(9, "solved", True)],
        ("bcp", "bcp-1", "isolated"): read(1, "a1", "d1", "c1") + read(2, "a2", "d1", "c2") + claim(8, "a1", "x", True) + [finished(9, "solved", True)],
        ("bcp", "bcp-2", "isolated"): claim(8, "a1", "y", False) + [finished(9, "wrong_claim", False)],
        ("math", "math-1", "fork"): py(1, "a1", "x=1", "p1") + [fork_ev(5)] + py(6, "a1", "x=1", "p2") + py(7, "a2", "x = 1", "p3")
                                    + py(8, "a3", "print(2)", "p4") + claim(9, "a1", "1", True) + [finished(9, "solved", True)],
        ("math", "math-2", "fork"): [fork_ev(5)] + claim(8, "a1", "2", False) + [finished(9, "wrong_claim", False)],
        ("math", "math-1", "fork-silent"): [fork_ev(5)] + claim(8, "a1", "1", True) + [finished(9, "solved", True)],
        ("math", "math-2", "fork-silent"): [fork_ev(5)] + claim(8, "a1", "2", False) + [finished(9, "wrong_claim", False)],
        ("math", "math-1", "isolated"): claim(8, "a1", "2", False) + [finished(9, "wrong_claim", False)],
        ("math", "math-2", "isolated"): claim(8, "a1", "2", False) + [finished(9, "wrong_claim", False)],
    }
    for (s, t, c), ev in runs.items():
        add_run(con, f"{s}-{t}-{c}-s1", c, t, 1, ev)
    m = matrix(tmp_path, conditions=("fork", "fork-silent", "isolated"), suites=("bcp", "math"))
    frozen(tmp_path, ("bcp-1", "bcp-2"), "bcp")
    return m, frozen(tmp_path, ("math-1", "math-2"), "math")


def test_phase2_analysis_on_a_synthetic_log(tmp_path):
    m, suites = phase2_log(tmp_path)
    md, data = an.analyse(tmp_path / "r.sqlite", m, suites)
    assert data["runs"] == data["expected"] == 12 and "INCOMPLETE" not in md
    assert all(data["solve"][s][c]["runs"] == 2 for s in ("bcp", "math") for c in ("fork", "fork-silent", "isolated"))  # scored as assigned
    v = data["verdict"]
    assert {"F1", "F2", "F3", "holm"} <= set(v) and not {"H1", "H2", "H3", "H4", "H5"} & set(v)
    assert list(v["holm"]) == ["F1", "F2", "F3"]
    assert v["F1"]["verdict"] == "NO GAIN" and v["F1"]["effect"] == 0 and v["F1"]["n"] == 2  # bcp only
    assert v["F2"]["verdict"] == "NO GAIN" and v["F2"]["n"] == 4 and v["F2"]["discordant"] == [1, 1]  # both suites
    assert v["F3"]["testable"] and v["F3"]["effect"] == pytest.approx(-50.0)  # bcp gain 0, math gain +50
    assert v["holm"]["F1"] == pytest.approx(an.holm([v["F1"]["mcnemar_p"], v["F2"]["mcnemar_p"], v["F3"]["p"]])[0])
    assert v["cost"]["bcp"]["ratio"] == pytest.approx(3.5)  # fork (300 + 400) / 1 solved vs isolated (100 + 100) / 1
    mech = data["mechanism"]
    f, fs, iso = mech["bcp"]["fork"], mech["bcp"]["fork-silent"], mech["bcp"]["isolated"]
    assert (f["forked"], f["ended_before_fork"], f["fallback"], f["distinct_directions"]) == ([1, 2], [1, 2], [0, 2], [1, 2])
    assert f["max_direction_jaccard_median"] == pytest.approx(1 / 3) and fs["max_direction_jaccard_median"] == 1.0 and "max_direction_jaccard_median" not in iso
    assert "| bcp | fork | 2 | 1/2 (50%) | 1/2 (50%) | 0/2 (0%) | 1/2 (50%) | 0.33 |" in md
    assert "median max word-Jaccard of directions" in md
    assert (fs["forked"], fs["fallback"], fs["distinct_directions"]) == ([2, 2], [1, 2], [0, 2])
    assert f["duplicate_reads"]["dup"] == 1 and f["duplicate_reads"]["total"] == 3  # bcp-1: d1 {a1, a2}, d2; bcp-2: d1
    assert (f["post_fork_duplicate_reads"]["dup"], f["post_fork_duplicate_reads"]["total"]) == (1, 2)
    assert iso["duplicate_reads"]["share"] == pytest.approx(1.0) and "post_fork_duplicate_reads" not in iso and "forked" not in iso
    mf = mech["math"]["fork"]
    assert (mf["duplicate_python"]["dup"], mf["duplicate_python"]["total"]) == (1, 4)
    assert (mf["post_fork_duplicate_python"]["dup"], mf["post_fork_duplicate_python"]["total"]) == (1, 3)
    assert "vs_isolated" in f["duplicate_reads"]
    for heading in ("## F1", "## F2", "## F3", "## Mechanism check", "## Cost"):
        assert heading in md
    assert "## H2" not in md


def test_phase2_mechanism_without_verdicts_on_incomplete_data(tmp_path):
    m, suites = phase2_log(tmp_path)
    con = sqlite3.connect(tmp_path / "r.sqlite")
    con.execute("DELETE FROM events WHERE run_id = 'math-math-2-isolated-s1'")
    con.commit()
    md, data = an.analyse(tmp_path / "r.sqlite", m, suites, allow_incomplete=True)
    assert "INCOMPLETE" in md and "verdict" not in data
    assert data["mechanism"]["bcp"]["fork"]["forked"] == [1, 2]


def test_phase1_analysis_has_no_phase2_keys(tmp_path):
    con = mklog(tmp_path / "r.sqlite")
    for c in ("single", "isolated", "polylogue"):
        for t, ok in (("bcp-1", True), ("bcp-2", c != "single")):
            add_run(con, f"bcp-{t}-{c}-s1", c, t, 1, claim(5, "a1", "x", ok) + [finished(6, "solved" if ok else "wrong_claim", ok)])
    md, data = an.analyse(tmp_path / "r.sqlite", matrix(tmp_path, conditions=("single", "isolated", "polylogue")), frozen(tmp_path))
    assert data["verdict"]["H2"] in ("TALK HELPS", "ONLY PARALLELISM", "NO GAIN") and list(data["verdict"]["holm"]) == ["H2", "H1", "H3"]
    assert not {"F1", "F2", "F3"} & set(data["verdict"]) and "mechanism" not in data
    assert "## H2" in md and "## F1" not in md


def test_domain_generalises_h3():
    def run(s, t, c, first):
        return an.Run(s, t, c, 1, f"{s}-{t}-{c}", "x", first, first, first, None, 1, 1, [], [])
    runs = [run("bcp", f"b{i}", c, (c == "polylogue") or i % 2 == 0) for i in range(6) for c in ("polylogue", "isolated")]
    runs += [run("math", f"m{i}", c, i % 3 == 0) for i in range(6) for c in ("polylogue", "isolated")]
    assert an._domain(runs, "polylogue", "isolated") == an._h3(runs)
    forked = [an.Run(r.suite, r.task, "fork" if r.condition == "polylogue" else r.condition, 1, r.run_id, "x", r.solved, r.first, r.best, None, 1, 1, [], [])
              for r in runs]
    assert an._domain(forked, "fork", "isolated") == an._h3(runs)


# --- golden: the phase-1 analysis output must not change when phase 2 is touched ---

GOLDEN = Path(__file__).parent / "golden"


def phase1_golden_log(tmp_path):
    """A small deterministic phase-1 log: five conditions, two suites, two seeds, with messages, reads, python, idle time, failed claims and an infra rerun."""
    import random as _random
    rng = _random.Random(11)
    con = mklog(tmp_path / "r.sqlite")
    sizes = {"bcp": 12, "math": 6}
    conds = ("single", "isolated", "stigmergic", "polylogue", "polylogue-bare")
    for suite, n in sizes.items():
        for ti in range(1, n + 1):
            task = f"{suite}-{ti}"
            for seed in (1, 2):
                for c in conds:
                    agents = ["a1"] if c == "single" else ["a1", "a2", "a3", "a4"]
                    ev, t = [{"kind": "agent_started", "t": 1, "agent": a} for a in agents], 3
                    scale = 1000 * (1 + (c == "polylogue") * (ti % 3 == 0) + (ti % 4))
                    for ai, a in enumerate(agents):
                        for k in range(3):
                            t += 2
                            doc = str(100 + (ti * 3 + (ai if c == "isolated" else 0) + k) % 7)
                            ev.append({**call(t, a, [("read_doc", {"id": doc})]), "call": k})
                            ev.append({"kind": "tool_call", "t": t, "agent": a, "callId": f"c{ai}{k}", "tool": "read_doc", "args": {"id": doc}})
                            ev.append({"kind": "tool_result", "t": t + 1, "agent": a, "callId": f"c{ai}{k}", "tool": "read_doc", "isError": k == 2 and ai == 1, "text": "text"})
                        t += 1
                        ev.append({"kind": "tool_call", "t": t, "agent": a, "callId": f"p{ai}", "tool": "run_python", "args": {"code": f"print({ti % 3})"}})
                        ev.append({"kind": "idle", "t": t + 1, "agent": a})
                        ev.append({"kind": "wake", "t": t + 4, "agent": a})
                    if c in ("polylogue", "polylogue-bare", "stigmergic"):
                        mid = f"m{ti}{seed}"
                        ev.append(msg(t + 5, mid, "a1", ["a2", "a3"], f"Doc {100 + ti % 7} looks right; answer maybe {ti}."))
                        ev.append(delivered(t + 6, "a2", mid))
                        ev.append(call(t + 7, "a2", [("read_doc", {"id": str(100 + ti % 7)})]))
                    ok = rng.random() < {"single": 0.5, "isolated": 0.85, "stigmergic": 0.6, "polylogue": 0.85, "polylogue-bare": 0.6}[c]
                    t += 12
                    if not ok and c != "single":
                        ev += claim(t, "a2", str(ti), False)
                        t += 1
                    ev += claim(t, "a1", str(ti), ok) if not (c == "isolated" and not ok) else claim(t, "a1", "none", False)
                    ev.append(finished(t + 1, "solved" if ok else "wrong_claim", ok, tokens=100 + 10 * ti + len(agents)))
                    rid = f"{suite}-{task}-{c}-s{seed}"
                    if ti == 1 and seed == 2 and c == "polylogue":
                        add_run(con, rid, c, task, seed, [finished(5, "infra_error", False)])
                        rid += "-r1"
                    add_run(con, rid, c, task, seed, [{**e, "t": e["t"] * scale, **({"wallMs": e["t"] * scale} if e["kind"] == "run_finished" else {})} for e in ev])
    return con


def test_phase1_analysis_matches_the_committed_golden_output(tmp_path):
    phase1_golden_log(tmp_path)
    m = {"name": "golden", "orderSeed": 1, "dataDir": "data", "servers": ["http://x/v1"], "conditions": ["single", "isolated", "stigmergic", "polylogue", "polylogue-bare"],
         "seeds": [1, 2], "suites": [{"suite": s, "split": "scored", "tokensPerAgent": 1, "wallClockMs": 1} for s in ("bcp", "math")],
         "rate": {"messagesPerMinute": 1, "maxMessageChars": 1}, "model": {}}
    mp = tmp_path / "m.json"
    mp.write_text(json.dumps(m))
    suites = tmp_path / "suites"
    for s, n in (("bcp", 12), ("math", 6)):
        d = suites / s
        d.mkdir(parents=True)
        (d / "frozen.json").write_text(json.dumps({"suite": s, "tasks": [{"id": f"{s}-{i}", "split": "scored", "task_sha256": "fp"} for i in range(1, n + 1)]}))
    md, data = an.analyse(tmp_path / "r.sqlite", mp, suites)
    js = json.dumps(data, indent=2, default=str) + "\n"
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN.mkdir(exist_ok=True)
        (GOLDEN / "phase1-analysis.md").write_text(md)
        (GOLDEN / "phase1-analysis.json").write_text(js)
    assert "## H2" in md and "H1" in data["verdict"] and data["verdict"]["H1"]["testable"]
    assert md == (GOLDEN / "phase1-analysis.md").read_text()
    assert js == (GOLDEN / "phase1-analysis.json").read_text()
