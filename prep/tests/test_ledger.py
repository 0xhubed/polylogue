import random

import pytest

import datetime as dt
import re
import sqlite3

import json

import polyprep.ledger as ledger_mod
from polyprep.ledger import (CITIES, FILLER, PRODUCTS, SUPPLIERS, _scores, answer_of, changes, effective, generate, margin, owner, prompt)
from polyprep.ledger_parse import DATE
from polyprep.store import write_corpus
from polyprep.ledger_parse import parse
from polyprep.ledger import ask
from polyprep.tokens import char_counter
from polyprep.verify import verify_claim

TARGET = 30_000


@pytest.fixture(scope="module", params=[1, 2, 3])
def world(request):
    return generate(request.param, TARGET, char_counter)


def test_deterministic_per_seed():
    a = generate(7, TARGET, char_counter)
    b = generate(7, TARGET, char_counter)
    assert a.docs == b.docs and a.question == b.question
    assert generate(8, TARGET, char_counter).docs != a.docs


def test_size_within_ten_percent(world):
    assert abs(world.tokens - TARGET) / TARGET <= 0.10


def test_answer_recomputed_from_the_documents(world):
    parsed = parse(world.docs)
    assert len(parsed.shipments) == world.shipments
    again = ask(parsed, world.question.template, random.Random(0))
    assert again is not None
    assert again.answer == world.question.answer
    ok, _ = verify_claim(world.question.answer, [], world.question.match, world.question.answer)
    assert ok


def test_corrections_override_and_recalls_exclude():
    w = generate(4, TARGET, char_counter)
    r = parse(w.docs)
    eff = {s.id: s for s in effective(r)}
    for c in r.corrections:
        s = eff.get(c.shipment)
        if s is None:
            continue
        later = [x for x in r.corrections if x.shipment == c.shipment and x.field == c.field and x.date > c.date]
        if not later:
            assert getattr(s, c.field) == c.new
    recalled = set(r.recalls)
    assert all(s.batch not in recalled for s in eff.values())


def test_transfers_change_owner_only_from_their_date():
    w = generate(5, TARGET, char_counter)
    r = parse(w.docs)
    for t in r.transfers:
        for s in r.shipments:
            if s.supplier == t.old:
                assert owner(r, s) == (t.new if s.date >= t.date else s.supplier)


def test_templates_cover_all_three_and_prompt_mentions_tools():
    templates = {generate(s, 8_000, char_counter).question.template for s in (3, 4, 5)}
    assert templates == {"A", "B", "C"}
    p = prompt("Which city?")
    assert "search(query)" in p and "list_docs(page)" in p and p.endswith("Question: Which city?")


@pytest.mark.parametrize("seed", [3, 4, 5])
def test_large_world_for_each_template(seed):
    target = 300_000
    w = generate(seed, target, char_counter)
    assert w.question.template == "ABC"[seed % 3]
    assert abs(w.tokens - target) / target <= 0.10
    parsed = parse(w.docs)
    assert len(parsed.shipments) == w.shipments
    again = ask(parsed, w.question.template, random.Random(0))
    assert again is not None and again.answer == w.question.answer


def test_questions_are_global_and_numeric():
    for seed, template in {3: "A", 4: "B", 5: "C"}.items():
        q = generate(seed, 8_000, char_counter).question
        assert (q.template, q.match) == (template, "numeric")
        assert q.text.endswith("Answer with a number.")
        assert q.answer.isdigit()
    assert generate(3, 8_000, char_counter).question.text.startswith("How many units did the supplier that delivered the most units receive credit for in 2024?")
    assert generate(5, 8_000, char_counter).question.text.startswith("How many units did the city that received the most units get in 2024?")


def test_a_and_c_answer_the_leaders_total():
    for seed in (3, 5, 6, 8):
        w = generate(seed, 8_000, char_counter)
        scores = _scores(w.records, w.question.template)
        top = max(scores.values())
        assert w.question.answer == str(top)
        assert sum(v == top for v in scores.values()) == 1  # a unique leader, so the question is well defined


def _fact_spans(s, body):
    """Character spans of the six facts of a shipment in its body."""
    return [m.span() for m in (
        DATE.search(body), re.search(re.escape(s.supplier), body), re.search(rf"\b{s.qty} units", body),
        re.search(re.escape(s.product), body), re.search(re.escape(s.batch), body), re.search(rf"\b{re.escape(s.city)}\b", body),
    )]


def test_facts_are_at_least_40_word_tokens_apart():
    for seed in range(1, 13):
        w = generate(seed, 30_000, char_counter)
        by_id = {s.id: s for s in parse(w.docs).shipments}
        checked = 0
        for _, title, body in w.docs:
            if not title.startswith("Shipment record "):
                continue
            s = by_id[title.removeprefix("Shipment record ")]
            tokens = [m.span() for m in re.finditer(r"\w+", body)]
            spans = _fact_spans(s, body)
            # token index range of each fact: first and last \w+ token overlapping its span
            ranges = [(min(i for i, t in enumerate(tokens) if t[1] > lo), max(i for i, t in enumerate(tokens) if t[0] < hi)) for lo, hi in spans]
            ranges.sort()
            for (_, end), (start, _) in zip(ranges, ranges[1:]):
                assert start - end - 1 >= 40, (title, ranges)
            checked += 1
        assert checked == w.shipments


def test_shipment_docs_have_at_least_8_filler_sentences():
    w = generate(2, 30_000, char_counter)
    for _, title, body in w.docs:
        if title.startswith("Shipment record "):
            assert sum(f in body for f in FILLER) >= 8, title


def test_search_snippets_never_show_two_facts(tmp_path):
    w = generate(3, 120_000, char_counter)
    path = tmp_path / "ledger.sqlite"
    write_corpus(path, w.docs)
    con = sqlite3.connect(path)
    sql = ("SELECT d.title, snippet(docs_fts, 1, '', '', ' … ', 24) FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid "
           "WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT 10")
    kinds = {
        "date": DATE, "qty": re.compile(r"\d+ units"), "batch": re.compile(r"B-\d{3}"),
        "supplier": re.compile("|".join(map(re.escape, SUPPLIERS))), "city": re.compile("|".join(CITIES)), "product": re.compile("|".join(PRODUCTS)),
    }
    recalled = set(w.records.recalls)
    queries = [f'"{b[2:]}"' for b in sorted({s.batch for s in w.records.shipments}) if b not in recalled]
    queries += [f'"{x}"' for x in sorted({s.supplier for s in w.records.shipments})]
    queries += [f'"{x}"' for x in sorted({s.city for s in w.records.shipments})]
    queries += [f'"{q} units"' for q in range(10, 501, 7)]
    asked = 0
    for q in queries:
        for title, snip in con.execute(sql, (q,)):
            if not title.startswith("Shipment record "):
                continue  # corrections, recalls and transfers state one or two facts by design
            shown = [k for k, rx in kinds.items() if rx.search(snip)]
            assert len(shown) <= 1, (q, shown, snip)
            asked += 1
    assert asked > 100  # shipment hits that were checked


def test_batch_ids_do_not_reveal_the_supplier():
    for seed in range(1, 7):
        by_supplier = {}
        for s in generate(seed, 120_000, char_counter).records.shipments:
            by_supplier.setdefault(s.supplier, set()).add(int(s.batch[2:]))
        # with ids allocated in blocks, a supplier's batch numbers sit inside 10 consecutive numbers
        assert all(max(nums) - min(nums) > 9 for nums in by_supplier.values()), (seed, by_supplier)


def test_no_name_aliases_any_more():
    assert not hasattr(ledger_mod, "aliases")


def test_every_world_passes_the_filters_at_120k():
    for seed in range(1, 36):
        w = generate(seed, 120_000, char_counter)
        t = w.question.template
        assert w.attempts <= 200
        assert answer_of(w.records, t) == w.question.answer
        ch = changes(w.records, t)
        assert ch["corrections"] or ch["recalls"] or (t == "A" and ch["transfers"])
        if t != "B":
            assert 0 < margin(w.records, t) <= 0.10
        assert abs(w.tokens - 120_000) / 120_000 <= 0.10


def test_transfers_have_distinct_recipients_and_late_dates():
    for seed in range(1, 36):
        r = generate(seed, 8_000, char_counter).records
        olds = {t.old for t in r.transfers}
        news = [t.new for t in r.transfers]
        assert len(olds) == 2 and len(set(news)) == 2 and not olds & set(news)
        assert all(dt.date(2024, 6, 1) <= t.date <= dt.date(2024, 11, 30) for t in r.transfers)
        assert all(c.date <= dt.date(2024, 12, 31) for c in r.corrections)


def test_single_seed_flag_parses(tmp_path, monkeypatch):
    import polyprep.ledger_gen as g

    seen = []
    monkeypatch.setattr(g, "qwen_counter", lambda: char_counter)
    monkeypatch.setattr(g, "DATA", tmp_path)
    monkeypatch.setattr(g, "generate", lambda seed, target, count: (seen.append(seed), generate(seed, 4_000, count))[1])
    assert g.main(["--budget", "2000", "--seeds", "5", "--pilot", "1"]) == 0
    assert seen == [5]


def _gen_main(tmp_path, monkeypatch, *args):
    import polyprep.ledger_gen as g

    monkeypatch.setattr(g, "qwen_counter", lambda: char_counter)
    monkeypatch.setattr(g, "DATA", tmp_path / "default-data")
    return g.main(list(args))


def _tasks(data_dir):
    con = sqlite3.connect(data_dir / "ledger" / "tasks.sqlite")
    rows = con.execute("SELECT id, aliases, match, info FROM tasks ORDER BY id").fetchall()
    con.close()
    return [(i, json.loads(a), m, json.loads(info)) for i, a, m, info in rows]


@pytest.mark.parametrize("factor", [0.5, 1.0])
def test_factor_sets_the_reading_cost(tmp_path, monkeypatch, factor):
    out = tmp_path / f"calib-{factor}"
    assert _gen_main(tmp_path, monkeypatch, "--budget", "40000", "--seeds", "4", "--pilot", "1", "--factor", str(factor), "--data-dir", str(out)) == 0
    [(tid, aliases, match, info)] = _tasks(out)
    assert info["factor"] == factor and info["budget"] == 40000
    assert abs(info["tokens"] - factor * 40000) / (factor * 40000) <= 0.10
    assert aliases == [] and match == "numeric"
    assert (out / "ledger" / f"corpus-{tid}.sqlite").exists()
    assert not (tmp_path / "default-data").exists()


def test_factor_defaults_to_two_and_data_dir_to_data(tmp_path, monkeypatch):
    assert _gen_main(tmp_path, monkeypatch, "--budget", "10000", "--seeds", "4", "--pilot", "0") == 0
    [(_, _, _, info)] = _tasks(tmp_path / "default-data")
    assert info["factor"] == 2.0
    assert abs(info["tokens"] - 20000) / 20000 <= 0.10
