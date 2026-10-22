import json

import pytest

from polyprep import DATA, ROOT
import hashlib

import polyprep.freeze as freeze
from polyprep.freeze import manifest, task_fingerprint
from polyprep.store import open_tasks, put_task, set_meta, write_corpus
from polyprep.verify import answer_hash


def test_manifest_has_hashes_not_answers(tmp_path):
    db = tmp_path / "tasks.sqlite"
    con = open_tasks(db)
    put_task(con, id="m-2", split="scored", prompt="p", answer="42", match="numeric", info={"source": "AIME 2026 I"})
    put_task(con, id="m-1", split="pilot", prompt="p", answer="7", match="numeric")
    put_task(con, id="m-0", split="candidate", prompt="p", answer="1", match="numeric")
    con.commit()
    m = manifest("math", db)
    assert [t["id"] for t in m["tasks"]] == ["m-1", "m-2"]
    assert m["tasks"][1] == {"id": "m-2", "split": "scored", "match": "numeric", "answer_sha256": answer_hash("42", "numeric"),
                             "task_sha256": task_fingerprint("numeric", "42", [], "p"), "info": {"source": "AIME 2026 I"}}
    assert "answer" not in m["tasks"][1]


def test_manifest_of_a_missing_database_is_a_readable_error_and_creates_nothing(tmp_path):
    db = tmp_path / "tasks.sqlite"
    with pytest.raises(FileNotFoundError, match="no task database"):
        manifest("math", db)
    assert not db.exists()


@pytest.mark.parametrize("suite", ["bcp", "ledger", "math"])
def test_frozen_manifests_match_data(suite):
    frozen = ROOT / "suites" / suite / "frozen.json"
    db = DATA / suite / "tasks.sqlite"
    if not frozen.exists() or not db.exists():
        pytest.skip(f"{suite}: no frozen.json or no data/ (only checked after the freeze, where data/ exists)")
    assert manifest(suite, db) == json.loads(frozen.read_text())


def test_bcp_manifest_keeps_only_provenance_never_question_text_or_docids(tmp_path):
    db = tmp_path / "tasks.sqlite"
    con = open_tasks(db)
    question = "Which novelist wrote a book about a ring under a mountain?"
    put_task(con, id="bcp-7", split="scored", prompt=f"Question: {question}", answer="Tolkien", match="contains", corpus="corpus.sqlite",
             info={"query_id": "7", "query": question, "gold": ["doc-gold-1", "doc-gold-2"], "evidence": ["doc-ev-1", "doc-ev-2", "doc-ev-3"]})
    con.commit()
    m = manifest("bcp", db)
    text = json.dumps(m)
    assert m["tasks"][0]["info"] == {"query_id": "7", "n_evidence": 3}
    assert question not in text and "ring under a mountain" not in text
    for docid in ("doc-gold-1", "doc-gold-2", "doc-ev-1", "doc-ev-2", "doc-ev-3"):
        assert docid not in text


def test_ledger_and_math_manifests_whitelist_provenance_keys(tmp_path):
    db = tmp_path / "tasks.sqlite"
    con = open_tasks(db)
    write_corpus(tmp_path / "corpus-ledger-001.sqlite", [("D-0001", "Memo", "nothing")])
    put_task(con, id="ledger-001", split="scored", prompt="p", answer="12", match="numeric", corpus="corpus-ledger-001.sqlite",
             info={"generator": "ledger-1", "seed": 1, "budget": 1000, "factor": 2.0, "template": "B", "tokens": 1999, "shipments": 9, "attempts": 0, "docs": 20})
    con.commit()
    assert manifest("ledger", db)["tasks"][0]["info"] == {"generator": "ledger-1", "seed": 1, "budget": 1000, "factor": 2.0, "template": "B"}
    db2 = tmp_path / "m.sqlite"
    con2 = open_tasks(db2)
    put_task(con2, id="math-gen-001", split="scored", prompt="p", answer="12", match="numeric", info={"generated": True, "kind": "last_digits", "seed": 1, "extra": "x"})
    con2.commit()
    assert manifest("math", db2)["tasks"][0]["info"] == {"generated": True, "kind": "last_digits", "seed": 1}


# The same example and hex are in packages/runtime/src/suites/registry.test.ts: both languages must agree.
FINGERPRINT_EXAMPLE = ("contains", "Tolkien", ["\U0001F600y", "Tolkien, J.", "\uff01x", "J. R. R. Tolkien"], "Question: Who wrote it?\nAnswer briefly.")
FINGERPRINT_HEX = "5f1855dfd8a6df876f092f6360ee9f7a6fb981b9a3291fca38996727e34e6247"


def test_task_fingerprint_matches_the_typescript_value():
    assert task_fingerprint(*FINGERPRINT_EXAMPLE) == FINGERPRINT_HEX
    # aliases are sorted by code point: U+FF01 before U+1F600 (UTF-16 order would put the emoji first)
    match, answer, aliases, prompt = FINGERPRINT_EXAMPLE
    joined = "\x01".join(["J. R. R. Tolkien", "Tolkien, J.", "\uff01x", "\U0001F600y"])
    assert FINGERPRINT_HEX == hashlib.sha256(f"{match}\x00{answer}\x00{joined}\x00{prompt}".encode()).hexdigest()


def test_ledger_manifest_hashes_the_corpus_file_and_bcp_records_the_revisions(tmp_path):
    db = tmp_path / "ledger" / "tasks.sqlite"
    con = open_tasks(db)
    write_corpus(tmp_path / "ledger" / "corpus-ledger-001.sqlite", [("D-0001", "Memo", "nothing")])
    put_task(con, id="ledger-001", split="scored", prompt="p", answer="12", match="numeric", corpus="corpus-ledger-001.sqlite")
    con.commit()
    t = manifest("ledger", db)["tasks"][0]
    assert t["corpus_sha256"] == hashlib.sha256((tmp_path / "ledger" / "corpus-ledger-001.sqlite").read_bytes()).hexdigest()
    bdb = tmp_path / "bcp" / "tasks.sqlite"
    bcon = open_tasks(bdb)
    put_task(bcon, id="bcp-1", split="scored", prompt="p", answer="A", match="contains", corpus="corpus.sqlite", info={"query_id": "1"})
    set_meta(bcon, "corpus_revision", "c-rev")
    set_meta(bcon, "queries_revision", "q-rev")
    m = manifest("bcp", bdb)
    assert (m["corpus_revision"], m["queries_revision"]) == ("c-rev", "q-rev")
    assert "corpus_sha256" not in m["tasks"][0]  # the bcp corpus is pinned by revision, not hashed (several GB)


def test_check_detects_a_changed_prompt_alias_or_ledger_corpus(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(freeze, "DATA", tmp_path / "data")
    monkeypatch.setattr(freeze, "ROOT", tmp_path / "repo")
    con = open_tasks(tmp_path / "data" / "ledger" / "tasks.sqlite")
    corpus = tmp_path / "data" / "ledger" / "corpus-ledger-001.sqlite"
    write_corpus(corpus, [("D-0001", "Memo", "nothing")])
    put_task(con, id="ledger-001", split="scored", prompt="How many?", answer="12", aliases=["twelve"], match="contains", corpus="corpus-ledger-001.sqlite")
    assert freeze.main(["ledger"]) == 0
    assert freeze.main(["ledger", "--check"]) == 0
    for sql, undo in [("UPDATE tasks SET prompt = 'How many units?'", "UPDATE tasks SET prompt = 'How many?'"),
                      ("UPDATE tasks SET aliases = '[\"12 units\"]'", "UPDATE tasks SET aliases = '[\"twelve\"]'")]:
        con.execute(sql)
        con.commit()
        assert freeze.main(["ledger", "--check"]) == 1
        con.execute(undo)
        con.commit()
        assert freeze.main(["ledger", "--check"]) == 0
    write_corpus(corpus, [("D-0001", "Memo", "something else")])
    assert freeze.main(["ledger", "--check"]) == 1
    assert "does NOT match" in capsys.readouterr().out
