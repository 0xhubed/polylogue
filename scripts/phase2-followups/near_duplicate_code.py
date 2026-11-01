import sqlite3, json, re, sys, difflib
from collections import defaultdict
c = sqlite3.connect(sys.argv[1])
def key(code): return re.sub(r"\s+", "", "\n".join(l.split("#",1)[0] for l in code.splitlines()))
res = defaultdict(list); shown = 0
for rid, cond in c.execute("select id, condition from runs where task_id like 'math%'").fetchall():
    calls = []; fork_at = None
    for seq, kind, p in c.execute("select seq, kind, payload from events where run_id=? order by seq", (rid,)):
        e = json.loads(p)
        if kind == "fork": fork_at = seq
        if kind == "tool_call" and e.get("tool") == "run_python":
            calls.append((seq, e["agent"], key(str((e.get("args") or {}).get("code","")))))
    for i, (seq, ag, k) in enumerate(calls):
        prev = [(s2, a2, k2) for s2, a2, k2 in calls[:i] if a2 != ag]
        if not prev: continue
        best, src = max((difflib.SequenceMatcher(None, k, k2, autojunk=False).ratio(), (s2, a2, k2)) for s2, a2, k2 in prev)
        inherited = fork_at is not None and src[0] < fork_at
        res[cond].append((best, inherited))
        if best >= 0.97 and shown < 2:
            shown += 1
            d = [l for l in difflib.ndiff([src[2]], [k]) if l[0] in "?"]
            sm = difflib.SequenceMatcher(None, src[2], k, autojunk=False)
            print("example", cond, round(best,3), [(t, src[2][i1:i2][:60], k[j1:j2][:60]) for t,i1,i2,j1,j2 in sm.get_opcodes() if t!="equal"][:4])
for cond, v in sorted(res.items()):
    n = len(v); hi = [x for x in v if x[0] >= .9]
    print(cond, "calls with an earlier other-agent call:", n, "| ratio>=0.9:", len(hi), f"({100*len(hi)/n:.0f}%)", "| of those, match is root's pre-fork code:", sum(1 for _, inh in hi if inh))
