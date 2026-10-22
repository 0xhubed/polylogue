import sqlite3

import pytest

from polyprep.store import open_tasks, put_task, set_split, write_corpus


def test_tasks_round_trip(tmp_path):
    con = open_tasks(tmp_path / "bcp" / "tasks.sqlite")
    put_task(con, id="bcp-1", split="candidate", prompt="Q?", answer="A", match="contains", aliases=["a1"], corpus="corpus.sqlite", info={"query_id": "1"})
    set_split(con, "bcp-1", "pilot")
    row = con.execute("SELECT split, aliases, info, corpus FROM tasks WHERE id = 'bcp-1'").fetchone()
    assert row == ("pilot", '["a1"]', '{"query_id": "1"}', "corpus.sqlite")


def test_numeric_keys_are_validated_at_write(tmp_path):
    con = open_tasks(tmp_path / "tasks.sqlite")
    with pytest.raises(ValueError, match="task m-1: numeric answer key 'x\\^2' is not exactly one number"):
        put_task(con, id="m-1", split="candidate", prompt="p", answer="x^2", match="numeric")
    with pytest.raises(ValueError, match="'2x\\+1'"):
        put_task(con, id="m-2", split="candidate", prompt="p", answer="7", match="numeric", aliases=["2x+1"])
    put_task(con, id="m-3", split="candidate", prompt="p", answer="3/4", match="numeric", aliases=["0.75"])
    assert con.execute("SELECT id FROM tasks").fetchall() == [("m-3",)]


def test_corpus_has_a_working_fts_index(tmp_path):
    path = tmp_path / "corpus.sqlite"
    n = write_corpus(path, [("d1", "Harbour", "The ferry to Ghent was delayed."), ("d2", "Memo", "Kessler AG supplied copper wire.")])
    assert n == 2
    con = sqlite3.connect(path)
    hits = con.execute("SELECT d.id FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid WHERE docs_fts MATCH '\"copper\"' ORDER BY bm25(docs_fts)").fetchall()
    assert hits == [("d2",)]
    assert write_corpus(path, [("d9", "Only", "one")]) == 1  # replaces the file
