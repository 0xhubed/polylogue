import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from polyprep.bcp import ORACLE_CHARS, compose_prompt, fit_docs, oracle_messages, select, title_of
from polyprep.bcp_fetch import decrypt_record, load_authors_module, store_tasks
from polyprep.bcp_screen import screen
from polyprep.store import open_tasks, put_task, write_corpus


def test_title_from_front_matter_url_or_first_line():
    assert title_of("---\ntitle: Arwa University holds annual cultural activities\nauthor: x\n---\nBody", "https://y") == "Arwa University holds annual cultural activities"
    assert title_of("No front matter here\nsecond line", "https://example.com/page") == "https://example.com/page"
    assert title_of("First line only", "") == "First line only"
    assert len(title_of("---\ntitle: " + "x" * 400 + "\n---", "")) == 160


def test_prompt_and_oracle_messages():
    p = compose_prompt("Who wrote it?")
    assert p.startswith("Answer the question below using the document collection.")
    assert "Question: Who wrote it?" in p and p.endswith("(a name, title, date or number).")
    msgs = oracle_messages("Who wrote it?", [("d1", "T", "x" * 50_000)])
    assert msgs[0]["role"] == "system" and "only the final short answer" in msgs[0]["content"]
    assert "[d1] T\n" + "x" * 50_000 + "\n\nQuestion:" in msgs[1]["content"] and msgs[1]["content"].endswith("Question: Who wrote it?")


def test_oracle_budget_is_shared_by_length_so_short_documents_stay_whole():
    both = oracle_messages("Q?", [("a", "A", "x" * 100_000), ("b", "B", "y" * 100_000)])[1]["content"]
    assert both.count("x") == 80_000 and both.count("y") == 80_000
    docs, cut = fit_docs([("long", "L", "z" * 300_000), ("short", "S", "s" * 10_000), ("mid", "M", "m" * 50_000)])
    assert [len(b) for _, _, b in docs] == [ORACLE_CHARS - 60_000, 10_000, 50_000] and cut  # input order kept; only the longest is cut
    assert fit_docs([("a", "A", "x" * 100), ("b", "B", "y" * 100)]) == ([("a", "A", "x" * 100), ("b", "B", "y" * 100)], False)


def test_select_ranks_by_spread_and_splits_reproducibly():
    screened = [(f"bcp-{i}", i % 4 != 0, i % 9) for i in range(100)]
    a = select(screened, take=35, pilot=5, seed=2026)
    assert len(a) == 35 and sorted(a.values()).count("pilot") == 5
    assert all(t in {x[0] for x in screened if x[1]} for t in a)
    kept_spread = min(next(x[2] for x in screened if x[0] == t) for t in a)
    assert all(x[2] <= kept_spread for x in screened if x[1] and x[0] not in a)
    assert select(screened, take=35, pilot=5, seed=2026) == a
    assert select(screened, take=35, pilot=5, seed=1) != a


class _Fake(BaseHTTPRequestHandler):
    posts = 0
    fail_on: str | None = None  # a question fragment the stub answers with HTTP 400
    reply = "Kessler AG"

    def do_GET(self):
        self._send({"data": [{"id": "qwen3.8-27b", "root": "unsloth/Qwen3.8-27B-NVFP4"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        q = body["messages"][1]["content"]
        assert (body["temperature"], body["top_p"], body["top_k"], body["min_p"]) == (0.6, 0.95, 20, 0) and body["chat_template_kwargs"] == {"reasoning_effort": "medium"}
        type(self).posts += 1
        if type(self).fail_on and type(self).fail_on in q:
            return self._send({"error": "boom"}, 400)
        self._send({"choices": [{"message": {"content": type(self).reply if "copper" in q else "no idea"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}})

    def _send(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture
def stub():
    _Fake.posts, _Fake.fail_on, _Fake.reply = 0, None, "Kessler AG"
    srv = HTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}/v1"
    srv.shutdown()


def _run(data, server, **kw):
    args = dict(server=server, model_id="qwen3.8-27b", hf_repo="unsloth/Qwen3.8-27B-NVFP4", concurrency=2, max_tokens=64, reasoning="medium", seed=1, take=3, pilot=1, split_seed=2026)
    return screen(data, **{**args, **kw})


def _tasks(data, n, *, answer=lambda copper: "Kessler AG" if copper else "Ghent", copper=lambda i: i % 2 == 0):
    write_corpus(data / "bcp" / "corpus.sqlite", [("d1", "Memo", "Kessler AG supplied copper wire."), ("d2", "Ferry", "The ferry went to Ghent.")])
    con = open_tasks(data / "bcp" / "tasks.sqlite")
    for i in range(n):
        c = copper(i)
        q = "Who supplied copper?" if c else "Where did the ferry go?"
        put_task(con, id=f"bcp-{i}", split="candidate", prompt=compose_prompt(q), answer=answer(c), match="contains", corpus="corpus.sqlite",
                 info={"query": q, "gold": ["d1" if c else "d2"], "evidence": ["d1"] * (i + 1)})
    return con


def test_screen_against_a_stub_server(tmp_path, stub):
    data = tmp_path / "data"
    con = _tasks(data, 8)
    assert _run(data, stub) == {"screened": 8, "passed": 4, "selected": 3, "infra": 0}
    assert _Fake.posts == 8
    splits = dict(con.execute("SELECT id, split FROM tasks").fetchall())
    assert sorted(i for i, s in splits.items() if s != "candidate") == ["bcp-2", "bcp-4", "bcp-6"]
    assert (data / "bcp" / "screen-failures.md").read_text().count("| bcp-") == 4
    row = con.execute("SELECT status, finish_reason, prompt_chars, truncated FROM screen WHERE task_id = 'bcp-0'").fetchone()
    assert row[0] == "ok" and row[1] == "stop" and row[2] > 0 and row[3] == 0
    assert _run(data, stub)["screened"] == 8
    assert _Fake.posts == 8  # resumes with no new calls


def test_alias_added_after_the_screen_counts_without_new_model_calls(tmp_path, stub):
    data = tmp_path / "data"
    con = _tasks(data, 4, answer=lambda c: "Kessler Aktiengesellschaft", copper=lambda i: True)
    assert _run(data, stub) == {"screened": 4, "passed": 0, "selected": 0, "infra": 0}
    con.execute("UPDATE tasks SET aliases = ?", (json.dumps(["Kessler AG"]),))
    con.commit()
    assert _run(data, stub) == {"screened": 4, "passed": 4, "selected": 3, "infra": 0}
    assert _Fake.posts == 4
    assert sum(1 for (s,) in con.execute("SELECT split FROM tasks") if s != "candidate") == 3


def test_a_failing_call_is_recorded_retried_and_never_selected(tmp_path, stub, capsys):
    data = tmp_path / "data"
    con = _tasks(data, 6)
    _Fake.fail_on = "ferry"
    assert _run(data, stub, take=10) == {"screened": 3, "passed": 3, "selected": 3, "infra": 3}
    assert "warning: only 3 tasks passed" in capsys.readouterr().out
    assert {r[0] for r in con.execute("SELECT task_id FROM screen WHERE status = 'infra'")} == {"bcp-1", "bcp-3", "bcp-5"}
    assert "model server answered 400" in con.execute("SELECT detail FROM screen WHERE task_id = 'bcp-1'").fetchone()[0]
    assert all(s == "candidate" for i, s in con.execute("SELECT id, split FROM tasks") if i in {"bcp-1", "bcp-3", "bcp-5"})
    _Fake.fail_on, before = None, _Fake.posts
    assert _run(data, stub, take=10) == {"screened": 6, "passed": 3, "selected": 3, "infra": 0}
    assert _Fake.posts - before == 3  # only the three errored tasks are retried


def test_resuming_with_a_different_screen_config_is_refused(tmp_path, stub):
    data = tmp_path / "data"
    _tasks(data, 2)
    _run(data, stub)
    with pytest.raises(RuntimeError, match="was screened with"):
        _run(data, stub, seed=2)


def _encrypt(plain, password):  # the authors' documented algorithm: SHA-256 of the canary, repeated to length, XOR, base64
    raw = plain.encode()
    key = hashlib.sha256(password.encode()).digest()
    key = key * (len(raw) // len(key)) + key[: len(raw) % len(key)]
    return base64.b64encode(bytes(a ^ b for a, b in zip(raw, key))).decode()


FAKE_AUTHORS = '''import base64, hashlib
DEFAULT_CANARY = "test canary"

def _key(password, n):
    k = hashlib.sha256(password.encode("utf-8")).digest()
    return k * (n // len(k)) + k[: n % len(k)]

def transform_decrypt(obj, password, skip_keys):
    if isinstance(obj, str):
        raw = base64.b64decode(obj)
        return bytes(a ^ b for a, b in zip(raw, _key(password, len(raw)))).decode("utf-8")
    if isinstance(obj, list):
        return [transform_decrypt(v, password, skip_keys) for v in obj]
    if isinstance(obj, dict):
        return {k: (v if k in skip_keys else transform_decrypt(v, password, skip_keys)) for k, v in obj.items()}
    return obj
'''


def test_records_are_decrypted_through_the_pinned_scripts_functions(tmp_path):
    script = tmp_path / "decrypt_dataset.py"
    script.write_text(FAKE_AUTHORS)
    enc = lambda t: _encrypt(t, "test canary")  # noqa: E731
    record = {"query_id": "7", "query": enc("Who supplied copper? " + "é" * 90), "answer": enc("Kessler AG"),
              "gold_docs": [{"docid": enc("d1"), "url": enc("https://x")}], "evidence_docs": [{"docid": enc("d1")}, {"docid": enc("d2")}]}
    out = decrypt_record(load_authors_module(script), record)
    assert out["query_id"] == "7" and out["query"].startswith("Who supplied copper?") and out["answer"] == "Kessler AG"
    assert [d["docid"] for d in out["gold_docs"]] == ["d1"] and [d["docid"] for d in out["evidence_docs"]] == ["d1", "d2"]


def test_refetch_keeps_reviewed_aliases_and_rejects_unknown_documents(tmp_path):
    con = open_tasks(tmp_path / "tasks.sqlite")
    rec = {"query_id": "7", "query": "Q?", "answer": "Kessler Aktiengesellschaft", "gold_docs": [{"docid": "d1"}], "evidence_docs": [{"docid": "d1"}]}
    assert store_tasks(con, [rec], {"d1"}) == 1
    con.execute("UPDATE tasks SET aliases = ?", (json.dumps(["Kessler AG"]),))
    con.commit()
    store_tasks(con, [rec], {"d1"})
    assert json.loads(con.execute("SELECT aliases FROM tasks WHERE id = 'bcp-7'").fetchone()[0]) == ["Kessler AG"]
    with pytest.raises(SystemExit, match="missing from the corpus"):
        store_tasks(con, [{**rec, "gold_docs": [{"docid": "zz"}]}], {"d1"})


def test_ctrl_c_cancels_queued_tasks_keeps_finished_rows_and_resumes(tmp_path, stub, capsys):
    data = tmp_path / "data"
    con = _tasks(data, 8)
    seen = {}

    def interrupt(done):
        if done == 2:
            seen["posts"] = _Fake.posts
            raise KeyboardInterrupt

    out = _run(data, stub, concurrency=1, after_row=interrupt)
    assert out["interrupted"] is True
    assert "interrupted" in capsys.readouterr().out
    import time
    time.sleep(0.3)
    rows = con.execute("SELECT COUNT(*) FROM screen").fetchone()[0]
    assert _Fake.posts <= seen["posts"] + 1  # at most the one call in flight at the stop; nothing queued was started
    assert rows == _Fake.posts and rows >= 2  # every finished call is kept
    assert out["screened"] == rows and out["not_screened"] == 8 - rows
    assert all(s == "candidate" for (s,) in con.execute("SELECT split FROM tasks"))  # no selection from a partial screen
    assert not (data / "bcp" / "screen-failures.md").exists()
    before = _Fake.posts
    assert _run(data, stub)["screened"] == 8
    assert _Fake.posts - before == 8 - rows  # the resume screens only the rest


def test_main_exits_130_on_ctrl_c(tmp_path, stub, monkeypatch):
    import polyprep.bcp_screen as bs

    def stop(*a, **kw):
        return {"interrupted": True, "screened": 1, "not_screened": 3}

    monkeypatch.setattr(bs, "screen", stop)
    assert bs.main(["--server", stub]) == 130


def test_rescreen_keeps_an_existing_selection_unless_reselect(tmp_path, stub, capsys):
    data = tmp_path / "data"
    con = _tasks(data, 8)
    chosen = lambda: sorted(i for i, s in con.execute("SELECT id, split FROM tasks") if s != "candidate")  # noqa: E731
    assert _run(data, stub)["selected"] == 3
    first = chosen()
    assert first == ["bcp-2", "bcp-4", "bcp-6"]
    con.execute("UPDATE tasks SET aliases = ? WHERE id = 'bcp-7'", (json.dumps(["no idea"]),))  # bcp-7 now passes and has the most evidence
    con.commit()
    out = _run(data, stub)
    assert out["passed"] == 5 and out["selected"] == 3
    assert chosen() == first  # the screen rows are updated, the splits are not
    assert con.execute("SELECT passed FROM screen WHERE task_id = 'bcp-7'").fetchone()[0] == 1
    assert "kept the existing selection" in capsys.readouterr().out
    _run(data, stub, reselect=True)
    assert chosen() == ["bcp-4", "bcp-6", "bcp-7"]


def test_refetch_keeps_pilot_and_scored_splits_unless_forced(tmp_path):
    con = open_tasks(tmp_path / "tasks.sqlite")
    recs = [{"query_id": q, "query": "Q?", "answer": "A", "gold_docs": [{"docid": "d1"}], "evidence_docs": [{"docid": "d1"}]} for q in ("1", "2", "3")]
    store_tasks(con, recs, {"d1"})
    con.execute("UPDATE tasks SET split = 'scored' WHERE id = 'bcp-1'")
    con.execute("UPDATE tasks SET split = 'pilot' WHERE id = 'bcp-2'")
    con.commit()
    store_tasks(con, recs, {"d1"})
    assert dict(con.execute("SELECT id, split FROM tasks").fetchall()) == {"bcp-1": "scored", "bcp-2": "pilot", "bcp-3": "candidate"}
    store_tasks(con, recs, {"d1"}, force=True)
    assert {s for (s,) in con.execute("SELECT split FROM tasks")} == {"candidate"}
