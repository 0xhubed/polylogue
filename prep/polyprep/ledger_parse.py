"""Reads rendered ledger documents back into Records. Used by tests to check that the answer follows from the text."""
from __future__ import annotations

import datetime as dt
import re

from polyprep.ledger import CITIES, MONTHS, PRODUCTS, SUPPLIERS, Correction, Records, Shipment, Transfer

DATE = re.compile(r"(\d{1,2}) (" + "|".join(MONTHS) + r") (\d{4})")


def _find(pattern: str | re.Pattern, text: str) -> re.Match:
    m = re.search(pattern, text)
    if m is None:
        raise ValueError(f"no match for {str(pattern)!r} in {text[:120]!r}")
    return m


def _date(text: str) -> dt.date:
    m = _find(DATE, text)
    return dt.date(int(m[3]), MONTHS.index(m[2]) + 1, int(m[1]))


def _one(text: str, names: list[str]) -> str:
    found = [n for n in names if n in text]
    if len(found) != 1:
        raise ValueError(f"expected exactly one of {names} in {text[:120]!r}, found {found}")
    return found[0]


def parse(docs: list[tuple[str, str, str]]) -> Records:
    shipments, recalls, corrections, transfers = [], [], [], []
    for _, title, body in docs:
        if title.startswith("Shipment record "):
            shipments.append(Shipment(
                _find(r"SH-\d{4}", body)[0], _date(body), _one(body, SUPPLIERS), _one(body, PRODUCTS),
                _find(r"B-\d{3}", body)[0], _one(body, CITIES), int(_find(r"(\d+) units", body)[1]),
            ))
        elif title.startswith("Correction to "):
            sid = _find(r"shipment (SH-\d{4})", body)[1]
            if m := re.search(r"was delivered to (.+?), not (.+?) as first recorded", body):
                corrections.append(Correction(sid, "city", m[2], m[1], _date(body)))
            else:
                m = _find(r"carried (\d+) units, not (\d+) as first recorded", body)
                corrections.append(Correction(sid, "qty", int(m[2]), int(m[1]), _date(body)))
        elif title.startswith("Recall notice for "):
            recalls.append(_find(r"B-\d{3}", body)[0])
        elif title.startswith("Contract transfer: "):
            m = _find(r"from (.+?), (.+?) took over all contracts of (.+?)\. ", body)
            transfers.append(Transfer(m[3], m[2], _date(m[1])))
    shipments.sort(key=lambda s: s.id)
    return Records(shipments, sorted(recalls), corrections, transfers)
