"""Phase-1 analysis (docs/superpowers/specs/2026-10-18-polylogue-analysis-design.md): scores, tests, verdicts and event-log metrics.

Standard library only, so the numbers do not depend on a statistics package. Reads the event log, the run matrix and
suites/<suite>/frozen.json; writes <name>-analysis.md and .json (they contain answers: keep them under data/).
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import sqlite3
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

from polyprep import ROOT
from polyprep.verify import NUMBER, _parse, _prepare, normalize_text

BOOT_SEED = 20261017
BOOT_N = 10_000
CONDITIONS = ["single", "isolated", "stigmergic", "polylogue", "polylogue-bare"]
WINDOW = 3  # a message is substantive if the receiver uses it within its next WINDOW model calls


class Incomplete(RuntimeError):
    pass


class FingerprintMismatch(RuntimeError):
    pass


@dataclass
class Run:
    suite: str
    task: str
    condition: str
    seed: int
    run_id: str
    reason: str
    solved: bool  # any claim passed
    first: bool  # the first claim passed (the primary score)
    best: bool  # best-of-N with the verifier (= solved); a reference for isolated
    first_pass_t: int | None
    tokens: int
    wall_ms: int
    agents: list[str]
    events: list[dict] = field(repr=False)


# --- loading ---

def _expected(matrix: dict, suites_dir: Path) -> list[tuple[str, str, str, int]]:
    cells = []
    for s in matrix["suites"]:
        frozen = json.loads((suites_dir / s["suite"] / "frozen.json").read_text())
        tasks = sorted(t["id"] for t in frozen["tasks"] if t["split"] == s["split"])
        cells += [(s["suite"], t, c, seed) for t in tasks for c in matrix["conditions"] for seed in matrix["seeds"]]
    return cells


def load(db: Path, matrix_path: Path, suites_dir: Path, *, allow_incomplete: bool = False) -> list[Run]:
    matrix = json.loads(Path(matrix_path).read_text())
    fingerprints = {}
    for s in matrix["suites"]:
        for t in json.loads((suites_dir / s["suite"] / "frozen.json").read_text())["tasks"]:
            fingerprints[t["id"]] = t["task_sha256"]
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    statuses = dict(con.execute("SELECT id, status FROM runs"))
    runs, missing, mismatched = [], [], []
    expected = _expected(matrix, suites_dir)
    for suite, task, cond, seed in expected:
        cell = f"{suite}-{task}-{cond}-s{seed}"
        run_id = f"{cell}-r1" if statuses.get(cell) == "infra_error" and f"{cell}-r1" in statuses else cell
        events = [json.loads(p) for (p,) in con.execute("SELECT payload FROM events WHERE run_id = ? ORDER BY seq", (run_id,))]
        end = next((e for e in events if e["kind"] == "run_finished"), None)
        if end is None:
            missing.append(cell)
            continue
        start = next(e for e in events if e["kind"] == "run_started")
        if start.get("taskFingerprint") != fingerprints[task]:
            mismatched.append(run_id)
        verifs = [e for e in events if e["kind"] == "verification"]
        first = bool(verifs) and verifs[0]["passed"]
        runs.append(Run(suite, task, cond, seed, run_id, end["reason"], end["solved"], first, end["solved"],
                        verifs[0]["t"] if first else None, end["totalTokens"], end["wallMs"],
                        [e["agent"] for e in events if e["kind"] == "agent_started"], events))
    con.close()
    if mismatched:
        raise FingerprintMismatch(f"task fingerprint differs from frozen.json in {len(mismatched)} runs: {', '.join(mismatched[:5])}")
    if missing and not allow_incomplete:
        raise Incomplete(f"{len(missing)} of {len(expected)} cells missing: {', '.join(missing[:5])}{' …' if len(missing) > 5 else ''}")
    return runs


# --- statistics ---

def mcnemar(b: int, c: int) -> float:
    """Exact two-sided McNemar: binomial test on the b + c discordant pairs."""
    n = b + c
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, k) for k in range(min(b, c) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def holm(ps: list[float]) -> list[float]:
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    out, running = [0.0] * len(ps), 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (len(ps) - rank) * ps[i]))
        out[i] = running
    return out


def _phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def wilcoxon_less(d: list[float]) -> float:
    """One-sided Wilcoxon signed-rank p for 'd tends to be below 0' (exact without ties, normal approximation with them)."""
    d = [x for x in d if x != 0]
    n = len(d)
    if n == 0:
        return 1.0
    order = sorted(range(n), key=lambda i: abs(d[i]))
    ranks = [0.0] * n
    i = 0
    ties = []
    while i < n:
        j = i
        while j + 1 < n and abs(d[order[j + 1]]) == abs(d[order[i]]):
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        ties.append(j - i + 1)
        i = j + 1
    w = sum(r for r, x in zip(ranks, d) if x > 0)
    if all(t == 1 for t in ties) and n <= 60:
        counts = [1] + [0] * (n * (n + 1) // 2)  # number of rank subsets with each sum
        for r in range(1, n + 1):
            for s in range(len(counts) - 1, r - 1, -1):
                counts[s] += counts[s - r]
        return sum(counts[: int(w) + 1]) / 2 ** n
    mean = n * (n + 1) / 4
    var = n * (n + 1) * (2 * n + 1) / 24 - sum(t ** 3 - t for t in ties) / 48
    return _phi((w - mean + 0.5) / math.sqrt(var)) if var > 0 else 1.0


def _boot(keys: list, stat, *, one_sided: bool = False) -> dict:
    rng = random.Random(BOOT_SEED)
    vals = []
    for _ in range(BOOT_N):
        v = stat([keys[rng.randrange(len(keys))] for _ in keys])
        if v is not None:
            vals.append(v)
    vals.sort()
    if not vals:
        return {"lo": None, "hi": None, "boot": []}
    q = lambda p: vals[min(len(vals) - 1, max(0, int(p * len(vals))))]
    return {"lo": q(0.05 if one_sided else 0.025), "hi": q(0.975), "boot": vals}


def paired_diff(pairs: dict[str, list[tuple[int, int]]]) -> dict:
    """pairs: task -> [(a, b) per seed]. Difference in solve rate a - b in points, 95% interval clustered by task."""
    keys = sorted(pairs)

    def stat(ks):
        flat = [p for k in ks for p in pairs[k]]
        return 100 * (sum(a for a, _ in flat) - sum(b for _, b in flat)) / len(flat) if flat else None

    flat = [p for k in keys for p in pairs[k]]
    b = sum(1 for a, c in flat if a and not c)
    c = sum(1 for a, cc in flat if cc and not a)
    ci = _boot(keys, stat)
    return {"effect": stat(keys), "lo": ci["lo"], "hi": ci["hi"], "n": len(flat), "mcnemar_p": mcnemar(b, c), "discordant": [b, c]}


def h2_verdict(h2: dict, parallel: dict) -> str:
    if h2["effect"] >= 10 and h2["lo"] is not None and h2["lo"] > 0:
        return "TALK HELPS"
    if parallel["effect"] >= 10 and parallel["lo"] is not None and parallel["lo"] > 0:
        return "ONLY PARALLELISM"
    return "NO GAIN"


# --- event-log metrics (docs/pilot-definitions.md) ---

_QUOTED = re.compile(r'["“”„«»]([^"“”„«»]{2,}?)["“”„«»]')
_WORD = re.compile(r"\S+")
_PRONOUN = {"I", "I'll", "I’ll", "I'm", "I’m", "I've", "I’ve", "I'd", "I’d"}  # "Now I" is not a name


def _numbers(text: str) -> set[Fraction]:
    return {v for m in NUMBER.finditer(_prepare(text)) if (v := _parse(m.group(0))) is not None}


def _entities(text: str) -> set[str]:
    ents = {normalize_text(q) for q in _QUOTED.findall(text)}
    run: list[str] = []
    for m in _WORD.finditer(text + " ."):
        w = m.group(0).strip("\"'“”‘’()[]{}.,;:!?")
        if w and w[0].isupper() and w[0].isalpha() and w not in _PRONOUN:
            run.append(w)
            if m.group(0)[-1] in ".,;:!?":  # punctuation closes a name
                if len(run) >= 2:
                    ents.add(normalize_text(" ".join(run)))
                run = []
        else:
            if len(run) >= 2:
                ents.add(normalize_text(" ".join(run)))
            run = []
    return {e for e in ents if e}


def substantive_messages(events: list[dict]) -> set[str]:
    """Ids of messages whose document id, number or quoted entity appears in a receiver's tool calls within its next WINDOW model calls.
    Items that also appear in the task prompt do not count: every agent has them anyway (amendment of 2026-10-18, pilot-definitions.md)."""
    task = next((e.get("task", "") for e in events if e["kind"] == "run_started"), "")
    task_nums, task_norm = _numbers(task), f" {normalize_text(task)} "
    calls = defaultdict(list)  # agent -> [(t, text of its tool calls)]
    for e in events:
        if e["kind"] == "model_call":
            calls[e["agent"]].append((e["t"], json.dumps([tc.get("args") for tc in e["toolCalls"]], ensure_ascii=False)))
    delivered = {(e["agent"], e["messageId"]): e["t"] for e in events if e["kind"] == "message_delivered"}
    found = set()
    for m in (e for e in events if e["kind"] == "message"):
        nums = _numbers(m["text"]) - task_nums
        ents = {e for e in _entities(m["text"]) if f" {e} " not in task_norm}
        if not nums and not ents:
            continue
        for y in m["recipients"]:
            if y == m["from"] or (y, m["id"]) not in delivered:
                continue
            after = [text for t, text in calls[y] if t > delivered[(y, m["id"])]][:WINDOW]
            target = " ".join(after)
            norm = f" {normalize_text(target)} "
            if nums & _numbers(target) or any(f" {e} " in norm for e in ents):
                found.add(m["id"])
                break
    return found


def duplicate_reads(events: list[dict]) -> tuple[int, int]:
    failed = {(e["agent"], e["callId"]) for e in events if e["kind"] == "tool_result" and e["tool"] == "read_doc" and e["isError"]}
    readers = defaultdict(set)
    for e in events:
        if e["kind"] == "tool_call" and e["tool"] == "read_doc" and (e["agent"], e["callId"]) not in failed:
            readers[str((e.get("args") or {}).get("id", ""))].add(e["agent"])
    return sum(1 for s in readers.values() if len(s) > 1), len(readers)


def _code_key(code: str) -> str:
    return re.sub(r"\s+", "", "\n".join(line.split("#", 1)[0] for line in code.splitlines()))


def duplicate_python(events: list[dict]) -> tuple[int, int]:
    seen = defaultdict(set)
    dup = total = 0
    for e in events:
        if e["kind"] == "tool_call" and e["tool"] == "run_python":
            key = _code_key(str((e.get("args") or {}).get("code", "")))
            total += 1
            if seen[key] - {e["agent"]}:
                dup += 1
            seen[key].add(e["agent"])
    return dup, total


def wrong_consensus(events: list[dict]) -> int:
    said = []  # (agent, normalized text) of messages and blackboard entries so far
    answers = {}
    count = 0
    for e in events:
        if e["kind"] == "message":
            said.append((e["from"], f" {normalize_text(e['text'])} "))
        elif e["kind"] == "blackboard":
            said.append((e["agent"], f" {normalize_text(e['text'])} "))
        elif e["kind"] == "claim_submitted":
            answers[e["agent"]] = normalize_text(e["answer"])
        elif e["kind"] == "verification" and not e["passed"]:
            a = answers.get(e["claimOf"], "")
            if a and any(who != e["claimOf"] and f" {a} " in text for who, text in said):
                count += 1
    return count


def idle_ms(events: list[dict]) -> dict[str, int]:
    end = next((e["t"] for e in events if e["kind"] == "run_finished"), 0)
    since, total = {}, defaultdict(int)
    for e in events:
        if e["kind"] == "idle":
            since[e["agent"]] = e["t"]
        elif e["kind"] == "wake" and e["agent"] in since:
            total[e["agent"]] += e["t"] - since.pop(e["agent"])
    for a, t in since.items():
        total[a] += end - t
    return dict(total)


# --- the analysis ---

def _pairs(runs: list[Run], a: str, b: str, suites: list[str], score=lambda r: r.first) -> dict:
    by = {(r.suite, r.task, r.condition, r.seed): r for r in runs}
    out = defaultdict(list)
    for (s, t, c, seed), r in by.items():
        if c == a and s in suites and (s, t, b, seed) in by:
            out[f"{s}:{t}"].append((int(score(r)), int(score(by[(s, t, b, seed)]))))
    return dict(out)


def _h1(runs: list[Run]) -> dict:
    by = {(r.task, r.condition, r.seed): r for r in runs if r.suite == "bcp"}
    pairs = defaultdict(list)
    for (t, c, seed), r in by.items():
        o = by.get((t, "isolated", seed))
        if c == "polylogue" and o and r.first and o.first:
            pairs[t].append((max(r.first_pass_t, 1), max(o.first_pass_t, 1)))
    flat = [p for v in pairs.values() for p in v]
    if len(flat) < 10:
        return {"testable": False, "pairs": len(flat)}

    def ratio(ks):
        fl = [p for k in ks for p in pairs[k]]
        return statistics.median(a for a, _ in fl) / statistics.median(b for _, b in fl) if fl else None

    ci = _boot(sorted(pairs), ratio)
    r = ratio(sorted(pairs))
    p = wilcoxon_less([math.log(a) - math.log(b) for a, b in flat])
    return {"testable": True, "pairs": len(flat), "ratio": r, "lo": ci["lo"], "hi": ci["hi"], "p": p, "holds": r <= 0.8}


def _h3(runs: list[Run]) -> dict:
    per = {s: _pairs(runs, "polylogue", "isolated", [s]) for s in ("bcp", "math")}
    if not all(per.values()):
        return {"testable": False}
    rng = random.Random(BOOT_SEED)
    mean = lambda prs: 100 * (sum(a for a, _ in prs) - sum(b for _, b in prs)) / len(prs)
    flat = {s: [p for v in per[s].values() for p in v] for s in per}
    est = mean(flat["bcp"]) - mean(flat["math"])
    keys = {s: sorted(per[s]) for s in per}
    vals = []
    for _ in range(BOOT_N):
        d = []
        for s in ("bcp", "math"):
            draw = [keys[s][rng.randrange(len(keys[s]))] for _ in keys[s]]
            d.append(mean([p for k in draw for p in per[s][k]]))
        vals.append(d[0] - d[1])
    vals.sort()
    p = sum(1 for v in vals if v <= 0) / len(vals)
    lo = vals[int(0.05 * len(vals))]
    return {"testable": True, "effect": est, "lo_one_sided": lo, "p": p, "holds": est > 0 and lo > 0}


def _cost(runs: list[Run], suite: str) -> dict:
    by = defaultdict(lambda: defaultdict(list))
    for r in runs:
        if r.suite == suite and r.condition in ("polylogue", "isolated"):
            by[r.task][r.condition].append(r)

    def ratio(ks):
        tok = {c: sum(x.tokens for k in ks for x in by[k][c]) for c in ("polylogue", "isolated")}
        sol = {c: sum(x.first for k in ks for x in by[k][c]) for c in ("polylogue", "isolated")}
        if not sol["polylogue"] or not sol["isolated"]:
            return None
        return (tok["polylogue"] / sol["polylogue"]) / (tok["isolated"] / sol["isolated"])

    keys = sorted(by)
    r = ratio(keys)
    ci = _boot(keys, ratio)
    return {"ratio": r, "lo": ci["lo"], "hi": ci["hi"], "meets_1_5": r is not None and r >= 1.5}


def _describe(runs: list[Run]) -> dict:
    out = defaultdict(dict)
    groups = defaultdict(list)
    for r in runs:
        groups[(r.suite, r.condition)].append(r)
    for (s, c), rs in sorted(groups.items()):
        agents = sum(len(r.agents) for r in rs)
        subs = [substantive_messages(r.events) for r in rs]
        senders = sum(len({e["from"] for e in r.events if e["kind"] == "message" and e["id"] in sub}) for r, sub in zip(rs, subs))
        first_sub = [min(e["t"] for e in r.events if e["kind"] == "message" and e["id"] in sub) for r, sub in zip(rs, subs) if sub]
        dup_r = [duplicate_reads(r.events) for r in rs]
        dup_p = [duplicate_python(r.events) for r in rs]
        verifs = [e for r in rs for e in r.events if e["kind"] == "verification"]
        idle = [v for r in rs for v in idle_ms(r.events).values()]
        out[s][c] = {
            "runs": len(rs),
            "messages_per_agent": sum(1 for r in rs for e in r.events if e["kind"] == "message") / max(agents, 1),
            "runs_with_substantive_message": sum(1 for x in subs if x),
            "agents_with_substantive_message": senders, "agents": agents,
            "median_ms_to_first_substantive": statistics.median(first_sub) if first_sub else None,
            "median_idle_ms_per_agent": statistics.median(idle) if idle else 0,
            "duplicate_reads": [sum(d for d, _ in dup_r), sum(n for _, n in dup_r)],
            "duplicate_python": [sum(d for d, _ in dup_p), sum(n for _, n in dup_p)],
            "wrong_consensus": sum(wrong_consensus(r.events) for r in rs),
            "claims_per_run": sum(1 for r in rs for e in r.events if e["kind"] == "claim_submitted") / len(rs),
            "false_claims": [sum(1 for v in verifs if not v["passed"]), len(verifs)],
            "end_reasons": dict(Counter(r.reason for r in rs)),
            "median_tokens": statistics.median(r.tokens for r in rs),
            "median_wall_s": statistics.median(r.wall_ms for r in rs) / 1000,
        }
    return out


def analyse(db: Path, matrix_path: Path, suites_dir: Path, *, allow_incomplete: bool = False) -> tuple[str, dict]:
    matrix = json.loads(Path(matrix_path).read_text())
    expected = len(_expected(matrix, suites_dir))
    runs = load(db, matrix_path, suites_dir, allow_incomplete=allow_incomplete)
    complete = len(runs) == expected
    suites = [s["suite"] for s in matrix["suites"]]
    solve = {s: {c: {"runs": sum(1 for r in runs if r.suite == s and r.condition == c),
                     "first": sum(r.first for r in runs if r.suite == s and r.condition == c),
                     "solved": sum(r.solved for r in runs if r.suite == s and r.condition == c)}
                 for c in matrix["conditions"] if any(r.suite == s and r.condition == c for r in runs)} for s in suites}
    data: dict = {"matrix": matrix["name"], "runs": len(runs), "expected": expected, "solve": solve, "describe": _describe(runs)}
    lines = [f"# Analysis: {matrix['name']}", "", "Contains answers in the event log it reads; keep this report under data/ (git-ignored).", ""]
    lines.append(f"Runs: {len(runs)} of {expected}." + ("" if complete else " **INCOMPLETE: no verdicts.**"))
    lines += ["", "## Solve counts (first claim; any claim in brackets where it differs)", "", "| suite | condition | runs | first claim | rate |", "|---|---|---|---|---|"]
    for s in suites:
        for c, v in solve[s].items():
            extra = f" ({v['solved']} any claim)" if v["solved"] != v["first"] else ""
            lines.append(f"| {s} | {c} | {v['runs']} | {v['first']}{extra} | {100 * v['first'] / v['runs']:.0f}% |")
    if complete and {"polylogue", "isolated", "single"} <= set(matrix["conditions"]) and "bcp" in suites:
        h2 = paired_diff(_pairs(runs, "polylogue", "isolated", ["bcp"]))
        par = paired_diff(_pairs(runs, "isolated", "single", ["bcp"]))
        h1, h3 = _h1(runs), _h3(runs)
        ps = [h2["mcnemar_p"], h1.get("p", 1.0), h3.get("p", 1.0)]
        adj = holm(ps)
        verdict = h2_verdict(h2, par)
        bare_pairs = _pairs(runs, "polylogue-bare", "isolated", suites)
        d = data["describe"]
        bare_agents = sum(d[s]["polylogue-bare"]["agents"] for s in suites if "polylogue-bare" in d[s])
        bare_senders = sum(d[s]["polylogue-bare"]["agents_with_substantive_message"] for s in suites if "polylogue-bare" in d[s])
        h4_diff = paired_diff(bare_pairs) if bare_pairs else None
        h4_share = bare_senders / bare_agents if bare_agents else None
        h4 = {"share_agents_substantive": h4_share, "diff_vs_isolated": h4_diff,
              "holds": h4_share is not None and h4_share < 0.30 and h4_diff is not None and abs(h4_diff["effect"]) <= 5}
        h5 = {s: _cost(runs, s) for s in suites}
        secondary = {name: paired_diff(_pairs(runs, a, b, suites)) for name, (a, b) in {
            "stigmergic - polylogue": ("stigmergic", "polylogue"), "polylogue - polylogue-bare": ("polylogue", "polylogue-bare"),
            "isolated - single": ("isolated", "single")}.items()}
        iso = [r for r in runs if r.condition == "isolated"]
        secondary["isolated best-of-N - first claim"] = {"effect": 100 * (sum(r.best for r in iso) - sum(r.first for r in iso)) / max(1, len(iso))}
        man = d["bcp"].get("polylogue", {})
        data["verdict"] = {"H2": verdict, "h2": h2, "only_parallelism_check": par, "holm": dict(zip(["H2", "H1", "H3"], adj)),
                           "H1": h1, "H3": h3, "H4": h4, "H5": h5, "secondary": secondary,
                           "manipulation_check": {"runs_with_substantive_message": man.get("runs_with_substantive_message"), "runs": man.get("runs"),
                                                  "messages_per_agent": {c: d["bcp"][c]["messages_per_agent"] for c in d["bcp"]}}}
        f = lambda x: "–" if x is None else f"{x:+.1f}"
        lines += ["", "## H2 (primary, bcp): polylogue vs isolated, first claim", "",
                  f"**Verdict: {verdict}.** Effect {f(h2['effect'])} points, 95% interval [{f(h2['lo'])}, {f(h2['hi'])}], n = {h2['n']} pairs; "
                  f"McNemar p = {h2['mcnemar_p']:.4f} (Holm {adj[0]:.4f}), discordant {h2['discordant'][0]} / {h2['discordant'][1]}.",
                  f"isolated − single: {f(par['effect'])} points [{f(par['lo'])}, {f(par['hi'])}].",
                  f"Manipulation check: {man.get('runs_with_substantive_message')} of {man.get('runs')} polylogue runs with a substantive message; "
                  "messages per agent " + ", ".join(f"{c} {d['bcp'][c]['messages_per_agent']:.2f}" for c in d["bcp"]) + "."]
        if adj[0] >= 0.05 and h2["lo"] is not None and h2["lo"] > 0:
            lines.append("Note: the interval excludes 0 but the Holm-adjusted McNemar p is ≥ 0.05; the verdict follows the interval (analysis plan §2).")
        lines += ["", "## Secondary hypotheses", "",
                  "- H1 (speed): " + (f"ratio of median times {h1['ratio']:.2f} [{h1['lo']:.2f}, {h1['hi']:.2f}] over {h1['pairs']} pairs, Wilcoxon p = {h1['p']:.4f} (Holm {adj[1]:.4f}); holds: {h1['holds']}" if h1["testable"] else f"not testable ({h1['pairs']} pairs < 10)"),
                  "- H3 (domain): " + (f"difference of differences {f(h3['effect'])} points, one-sided 95% bound {f(h3['lo_one_sided'])}, p = {h3['p']:.4f} (Holm {adj[2]:.4f}); holds: {h3['holds']}" if h3["testable"] else "not testable"),
                  "- H4 (collapse without norms): " + (f"{100 * h4_share:.0f}% of polylogue-bare agents sent a substantive message; polylogue-bare − isolated {f(h4_diff['effect'])} [{f(h4_diff['lo'])}, {f(h4_diff['hi'])}]; holds: {h4['holds']}" if h4_share is not None and h4_diff else "not testable"),
                  "- H5 (cost, polylogue/isolated tokens per solved task): " + "; ".join(f"{s} " + ("–" if v["ratio"] is None else f"{v['ratio']:.2f} [{'–' if v['lo'] is None else f'{v['lo']:.2f}'}, {'–' if v['hi'] is None else f'{v['hi']:.2f}'}]") for s, v in h5.items()),
                  "", "## Secondary comparisons (both suites, first claim)", ""]
        for name, v in secondary.items():
            lines.append(f"- {name}: {f(v['effect'])} points" + (f" [{f(v['lo'])}, {f(v['hi'])}]" if "lo" in v else ""))
    lines += ["", "## Event-log metrics", "", "| suite | condition | msgs/agent | runs with subst. msg | agents with subst. msg | dup reads | dup python | wrong consensus | claims/run | false claims | median tokens | median wall (s) | end reasons |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s, cs in data["describe"].items():
        for c, v in cs.items():
            dr, dp, fc = v["duplicate_reads"], v["duplicate_python"], v["false_claims"]
            lines.append(f"| {s} | {c} | {v['messages_per_agent']:.2f} | {v['runs_with_substantive_message']}/{v['runs']} | {v['agents_with_substantive_message']}/{v['agents']} | "
                         f"{dr[0]}/{dr[1]} | {dp[0]}/{dp[1]} | {v['wrong_consensus']} | {v['claims_per_run']:.2f} | {fc[0]}/{fc[1]} | {v['median_tokens']:.0f} | {v['median_wall_s']:.0f} | "
                         + ", ".join(f"{k} {n}" for k, n in sorted(v["end_reasons"].items())) + " |")
    return "\n".join(lines) + "\n", data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--matrix", type=Path, required=True)
    ap.add_argument("--suites", type=Path, default=ROOT / "suites")
    ap.add_argument("--out-dir", type=Path, default=ROOT / "data" / "reports")
    ap.add_argument("--allow-incomplete", action="store_true", help="analyse a partial log (no verdicts), e.g. pilot data")
    a = ap.parse_args(argv)
    try:
        md, data = analyse(a.db, a.matrix, a.suites, allow_incomplete=a.allow_incomplete)
    except (Incomplete, FingerprintMismatch) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    a.out_dir.mkdir(parents=True, exist_ok=True)
    name = data["matrix"]
    (a.out_dir / f"{name}-analysis.md").write_text(md)
    (a.out_dir / f"{name}-analysis.json").write_text(json.dumps(data, indent=2, default=str))
    print(f"wrote {a.out_dir / f'{name}-analysis.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
