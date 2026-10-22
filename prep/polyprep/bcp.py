"""BrowseComp-Plus: pinned sources, prompts and the task selection rule (spec §4.1, §5)."""
from __future__ import annotations

import random

DECRYPT_COMMIT = "046949032b0328319cc9a02663a759ec601d9402"
DECRYPT_URL = f"https://raw.githubusercontent.com/texttron/BrowseComp-Plus/{DECRYPT_COMMIT}/scripts_build_index/decrypt_dataset.py"
QUERIES_REVISION = "144cff8e35b5eaef7e526346aa60774a9deb941f"
CORPUS_REVISION = "b27b02bc3e45511b8b82a13e6f90ce761df726f6"
ORACLE_CHARS = 160_000


def title_of(text: str, url: str) -> str:
    if text.startswith("---\n"):
        for line in text.split("\n")[1:]:
            if line == "---":
                break
            if line.startswith("title:"):
                return line[len("title:"):].strip()[:160]
    if url:
        return url[:160]
    return next((l.strip() for l in text.split("\n") if l.strip()), "(untitled)")[:160]


def compose_prompt(question: str) -> str:
    return ("Answer the question below using the document collection. search(query) finds documents by keywords; read_doc(id, page) reads one page of a document.\n\n"
            f"Question: {question}\n\nAnswer with a short exact answer (a name, title, date or number).")


def fit_docs(gold: list[tuple[str, str, str]], budget: int = ORACLE_CHARS) -> tuple[list[tuple[str, str, str]], bool]:
    """Cut the gold documents to a total character budget: shortest first, each gets min(its length, what is left / documents left),
    so short documents stay whole and only the longest are cut. Returns the documents in their original order and whether any was cut."""
    left = budget
    allowed: dict[int, int] = {}
    for n, idx in enumerate(sorted(range(len(gold)), key=lambda i: len(gold[i][2]))):
        allowed[idx] = min(len(gold[idx][2]), left // (len(gold) - n))
        left -= allowed[idx]
    cut = [(i, t, b[:allowed[k]]) for k, (i, t, b) in enumerate(gold)]
    return cut, any(allowed[k] < len(gold[k][2]) for k in allowed)


def oracle_messages(question: str, gold: list[tuple[str, str, str]]) -> list[dict]:
    docs = "\n\n".join(f"[{i}] {t}\n{b}" for i, t, b in fit_docs(gold)[0])
    return [
        {"role": "system", "content": "You are given documents and a question. Reply with only the final short answer (a name, title, date or number)."},
        {"role": "user", "content": f"{docs}\n\nQuestion: {question}"},
    ]


def select(screened: list[tuple[str, bool, int]], *, take: int = 35, pilot: int = 5, seed: int = 2026) -> dict[str, str]:
    """Survivors of the oracle screen, most evidence documents first (ties by id), then a seeded pilot/scored split."""
    survivors = sorted((x for x in screened if x[1]), key=lambda x: (-x[2], x[0]))[:take]
    ids = [x[0] for x in survivors]
    order = sorted(ids)
    random.Random(seed).shuffle(order)
    return {t: ("pilot" if i < pilot else "scored") for i, t in enumerate(order)}
