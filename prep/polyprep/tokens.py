"""Token counters for sizing the ledger corpus."""
from __future__ import annotations

import math
from collections.abc import Callable

Counter = Callable[[str], int]
TOKENIZER_REPO = "unsloth/Qwen3.8-27B-NVFP4"
TOKENIZER_REVISION = "7d6f8d4d72f56b92b3cdbf22f156b90e1bab0108"


def char_counter(s: str) -> int:
    """Rough stand-in for tests: about 3 characters per token (measured on ledger prose with the Qwen tokenizer)."""
    return math.ceil(len(s) / 3)


def qwen_counter() -> Counter:
    from tokenizers import Tokenizer

    tok = Tokenizer.from_pretrained(TOKENIZER_REPO, revision=TOKENIZER_REVISION)
    return lambda s: len(tok.encode(s).ids)
