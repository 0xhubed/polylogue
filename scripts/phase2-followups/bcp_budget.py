import sqlite3, json, statistics as st, sys
from collections import defaultdict
c = sqlite3.connect(sys.argv[1]); suite = sys.argv[2]
rows = defaultdict(list)
for rid, cond in c.execute("select id, condition from runs where task_id like ?", (suite + '%',)).fetchall():
    ev = [(k, json.loads(p)) for k, p in c.execute("select kind, payload from events where run_id=? order by seq", (rid,))]
    calls = [e for k, e in ev if k == "model_call"]
    tot = sum(e["tokensIn"] + e["tokensOut"] for e in calls)
    fin = next(e for k, e in ev if k == "run_finished")
    fork_i = next((i for i, (k, _) in enumerate(ev) if k == "fork"), None)
    pre = post_copy_inh = 0; prefix = None
    if fork_i is not None:
        pre = sum(e["tokensIn"] + e["tokensOut"] for k, e in ev[:fork_i] if k == "model_call")
        # prefix = root's last pre-fork call input + output (its history at the fork)
        last = [e for k, e in ev[:fork_i] if k == "model_call"][-1]
        prefix = last["tokensIn"] + last["tokensOut"]
        for k, e in ev[fork_i:]:
            if k == "model_call" and e["agent"] != "a1" and e["tokensIn"] > 0:
                post_copy_inh += min(prefix, e["tokensIn"])
    tin = sum(e["tokensIn"] for e in calls); tout = sum(e["tokensOut"] for e in calls)
    ncalls = sum(1 for e in calls if e["tokensIn"] > 0)
    reads = sum(1 for k, e in ev if k == "tool_call" and e.get("tool") == "read_doc")
    rows[cond].append(dict(tot=tot, check=fin.get("totalTokens"), pre=pre, inh=post_copy_inh, prefix=prefix or 0,
                           tin=tin, tout=tout, calls=ncalls, reads=reads, solved=fin["solved"], reason=fin["reason"]))
def med(v): return round(st.median(v)) if v else None
for cond, rs in sorted(rows.items()):
    mism = sum(1 for r in rs if r["check"] is not None and r["check"] != r["tot"])
    print(f"\n{cond} (n={len(rs)}, totalTokens mismatches {mism})")
    for key in ("tot", "tin", "tout", "pre", "prefix", "inh", "calls", "reads"):
        print(f"  median {key}: {med([r[key] for r in rs])}   sum share of tot: {sum(r[key] for r in rs)/sum(r['tot'] for r in rs):.2f}" if key in ('tin','tout','pre','inh') else f"  median {key}: {med([r[key] for r in rs])}")
    b = [r for r in rs if r["reason"] == "budget"]
    if b and cond != "isolated":
        print(f"  budget-ended runs {len(b)}: median inherited share {st.median(r['inh']/r['tot'] for r in b):.2f}, pre-fork share {st.median(r['pre']/r['tot'] for r in b):.2f}")
