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

def matrix(tmp_path, conditions=("single", "isolated"), seeds=(1,)):
    m = {"name": "t", "orderSeed": 1, "dataDir": "data", "servers": ["http://x/v1"], "conditions": list(conditions), "seeds": list(seeds),
         "suites": [{"suite": "bcp", "split": "scored", "tokensPerAgent": 1, "wallClockMs": 1}], "rate": {"messagesPerMinute": 1, "maxMessageChars": 1},
         "model": {}}
    p = tmp_path / "m.json"
    p.write_text(json.dumps(m))
    return p


def frozen(tmp_path, ids=("bcp-1", "bcp-2")):
    d = tmp_path / "suites" / "bcp"
    d.mkdir(parents=True)
    (d / "frozen.json").write_text(json.dumps({"suite": "bcp", "tasks": [{"id": i, "split": "scored", "task_sha256": "fp"} for i in ids]}))
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
