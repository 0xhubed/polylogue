"""Answer verification. Mirrors packages/runtime/src/suites/verify.ts; both pass suites/verify-vectors.json."""
from __future__ import annotations

import hashlib
import re
import sys
import unicodedata
from fractions import Fraction

# Numbers of any length get a verdict, as with BigInt in the TypeScript verifier (CPython caps int<->str at 4,300 digits).
sys.set_int_max_str_digits(0)

ARTICLES = {"a", "an", "the"}
# What JavaScript's String.prototype.trim strips (WhiteSpace + LineTerminator); Python's str.strip() differs (\x1c-\x1f, \x85).
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
BETWEEN_DIGITS = set(".,-/:")
DIGITS = set("0123456789")
# Thousands separators only in well-formed groups: 1,000 and 12,345,678 — not 0,001, 1,5 or 1,2345.
THOUSANDS = re.compile(r"(?<![0-9])[1-9][0-9]{0,2}(?:,[0-9]{3})+(?![0-9])")
# A number token may not touch a letter or digit on either side ([^\W_] = Unicode letter or digit).
NUMBER = re.compile(r"(?<![^\W_])(?:-?\\d?frac\{-?[0-9]+\}\{[0-9]+\}|-?[0-9]+\.[0-9]+|-?\.[0-9]+|-?[0-9]+/[0-9]+|-?[0-9]+)(?![^\W_])")


def _prepare(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).replace("−", "-")
    return THOUSANDS.sub(lambda m: m.group(0).replace(",", ""), s)


# Letters with no Unicode decomposition that a writer drops the accent from as readily as from é or ş.
FOLD = {"ı": "i", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss", "æ": "ae", "œ": "oe"}


def _fold(s: str) -> str:
    """Diacritics off ("Kış Bahçesi" -> "kis bahcesi"): decompose, drop marks, recompose (so Hangul and the like come back whole), then FOLD. Expects lowercase."""
    s = "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.category(c).startswith("M"))
    return "".join(FOLD.get(c, c) for c in unicodedata.normalize("NFC", s))


def normalize_text(s: str) -> str:
    chars = list(_fold(_prepare(s).lower()))
    out = []
    for i, ch in enumerate(chars):
        cat = unicodedata.category(ch)
        if cat.startswith("M"):
            continue
        if cat[0] in "LN":
            out.append(ch)
        elif ch in BETWEEN_DIGITS and 0 < i < len(chars) - 1 and chars[i - 1] in DIGITS and chars[i + 1] in DIGITS:
            out.append(ch)
        else:
            out.append(" ")
    return " ".join(w for w in "".join(out).split() if w not in ARTICLES)


def _parse(tok: str) -> Fraction | None:
    if m := re.fullmatch(r"(-?)\\d?frac\{(-?[0-9]+)\}\{([0-9]+)\}", tok):
        return None if int(m[3]) == 0 else Fraction((-1 if m[1] else 1) * int(m[2]), int(m[3]))
    if m := re.fullmatch(r"(-?[0-9]+)/([0-9]+)", tok):
        return None if int(m[2]) == 0 else Fraction(int(m[1]), int(m[2]))
    if m := re.fullmatch(r"(-?)([0-9]*)\.([0-9]+)", tok):
        n = int((m[2] or "0") + m[3])
        return Fraction(-n if m[1] else n, 10 ** len(m[3]))
    if re.fullmatch(r"-?[0-9]+", tok):
        return Fraction(int(tok))
    return None


def numeric_value(s: str) -> Fraction | None:
    """The value of the one number in a claim, or None when there is none or more than one."""
    tokens = NUMBER.findall(_prepare(s))
    return _parse(tokens[0]) if len(tokens) == 1 else None


def numeric_key(s: str) -> Fraction | None:
    """A numeric answer key: the whole trimmed key must be one number token (so "x^2" or "2x+1" are refused)."""
    p = _prepare(s).strip(JS_WHITESPACE)
    tokens = NUMBER.findall(p)
    return _parse(p) if len(tokens) == 1 and tokens[0] == p else None


HEDGES = ("or", "either")


def _hedged(claim: str, target: str) -> bool:
    """A claim naming alternatives ("Tolkien or Lewis") does not contain an answer, unless the answer itself has that word ("War or Peace")."""
    c, t = claim.split(" "), target.split(" ")
    return any(h in c and h not in t for h in HEDGES)


def verify_claim(answer: str, aliases: list[str], match: str, claim: str) -> tuple[bool, str | None]:
    shown = claim.strip(JS_WHITESPACE)[:200]
    targets = [answer, *aliases]
    if match == "numeric":
        got = numeric_value(claim)
        if got is None:
            return False, f"no single number in the claim: {shown}"
        return (True, None) if any(numeric_value(t) == got for t in targets) else (False, f"expected {answer}, got {shown}")
    c = normalize_text(claim)
    if c:
        for t in (normalize_text(x) for x in targets):
            if not t:
                continue
            if c == t:
                return True, None
            if match == "contains" and len(c) <= 3 * len(t) and f" {t} " in f" {c} " and not _hedged(c, t):
                return True, None
    return False, f"expected {answer}, got {shown}"


def answer_hash(answer: str, match: str) -> str:
    if match == "numeric":
        v = numeric_key(answer)
        if v is None:
            raise ValueError(f"numeric answer key {answer!r} is not exactly one number")
        key = f"{v.numerator}/{v.denominator}"
    else:
        key = normalize_text(answer)
    return hashlib.sha256(key.encode()).hexdigest()
