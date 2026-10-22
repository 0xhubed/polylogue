import json
from fractions import Fraction

import pytest

from polyprep import ROOT
from polyprep.verify import answer_hash, normalize_text, numeric_key, numeric_value, verify_claim

VECTORS = json.loads((ROOT / "suites" / "verify-vectors.json").read_text())


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: f"{c['match']}:{c['claim']!r}")
def test_vectors_match_the_typescript_verifier(case):
    passed, _ = verify_claim(case["answer"], case["aliases"], case["match"], case["claim"])
    assert passed is case["passed"]


@pytest.mark.parametrize("case", VECTORS["normalize"], ids=lambda c: c["in"])
def test_normalize_vectors(case):
    assert normalize_text(case["in"]) == case["out"]


def test_numeric_value_and_hash():
    assert numeric_value("-\\frac{2}{4}") == Fraction(-1, 2)
    assert numeric_value("1 and 2") is None
    assert answer_hash("3/4", "numeric") == answer_hash("0.75", "numeric")
    assert answer_hash("The Hobbit", "exact") == answer_hash("hobbit", "contains")
    assert len(answer_hash("x", "exact")) == 64


def test_numeric_key():
    assert numeric_key("204") == 204
    assert numeric_key(" 3/4 ") == Fraction(3, 4)
    assert numeric_key("-\\frac{1}{2}") == Fraction(-1, 2)
    assert numeric_key("1,000") == 1000
    for bad in ("x^2", "2x+1", "between 1 and 2", ""):
        assert numeric_key(bad) is None


def test_numeric_key_trims_like_javascript():
    assert numeric_key("\ufeff5") == 5  # JS trim() strips the BOM
    assert numeric_key("\x1c5") is None  # ...but not the file separator that str.strip() strips


def test_numeric_hash_refuses_non_number_keys():
    with pytest.raises(ValueError, match="not exactly one number"):
        answer_hash("x^2", "numeric")


def test_failure_details():
    assert verify_claim("204", [], "numeric", "between 200 and 210") == (False, "no single number in the claim: between 200 and 210")
    assert verify_claim("Lyon", [], "exact", "Ghent") == (False, "expected Lyon, got Ghent")
