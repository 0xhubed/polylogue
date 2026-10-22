"""Minimal OpenAI-compatible client for the oracle screen (same sampling as runs: suites/sampling.json, seed, chat_template_kwargs)."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

# Shared with the runtime (packages/runtime/src/model/provider.ts).
SAMPLING = {k: v for k, v in json.loads((Path(__file__).resolve().parents[2] / "suites" / "sampling.json").read_text()).items() if not k.startswith("_")}


def _get(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def check_server(server: str, model_id: str, hf_repo: str) -> None:
    try:
        body = _get(f"{server}/models", 10)
    except (OSError, ValueError) as e:  # urllib errors are OSErrors; a body that is not JSON is a ValueError
        raise RuntimeError(f"model server at {server} is unreachable or malformed: {e}") from e
    if not isinstance(body, dict):
        raise RuntimeError(f"model server at {server} returned a malformed model list")
    served = next((m for m in body.get("data", []) if m.get("id") == model_id), None)
    if served is None:
        raise RuntimeError(f'model server at {server} does not serve "{model_id}"')
    if served.get("root") != hf_repo:
        raise RuntimeError(f'model "{model_id}" serves {served.get("root")}, expected {hf_repo}')


def chat(server, model_id, messages, *, seed, max_tokens, reasoning_effort, timeout=1800, retries=3) -> dict:
    payload = {
        "model": model_id,
        "messages": messages,
        **SAMPLING,
        "seed": seed,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"reasoning_effort": reasoning_effort},
    }
    req = urllib.request.Request(f"{server}/chat/completions", data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise RuntimeError(f"model server answered {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from e
            err: OSError = e
        except OSError as e:  # transport errors and timeouts
            err = e
        else:
            try:
                body = json.loads(text)
                choice = body["choices"][0]
                msg = choice["message"]
                return {"finish_reason": choice.get("finish_reason"), "content": msg.get("content") or "", "reasoning": msg.get("reasoning_content") or msg.get("reasoning") or "", "usage": body.get("usage", {})}
            except (ValueError, KeyError, IndexError, TypeError, AttributeError) as e:
                raise RuntimeError(f"model server returned a malformed reply: {text[:200]}") from e
        if attempt == retries:
            raise err
        time.sleep(2**attempt)
    raise AssertionError("unreachable")
