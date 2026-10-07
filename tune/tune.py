#!/usr/bin/env python3
"""Tunes the prompt-polish mod for speed and accuracy, from what its last prompts measured.

The mod writes one event per polished prompt to <state>/events/ (time taken, effort used, and the outcome: rewritten,
unchanged, guarded when the rewrite lost something to be kept exactly, failed, timeout) and runs this after each prompt.
It changes <state>/tuning.json only when a rule below fires, one change per run, and prints that change in one line
(the mod shows it as a toast); otherwise it prints nothing. Every change is kept in tuning.json's history with its
reason, and judged only on prompts sent after the last change.

Rules, in order:
  accuracy  guarded on 15%+ of 8+ prompts (2 or more)      -> effort one step up (low, medium, high)
  timeout   of 10+ prompts, a straggler ran past 3 x p90, or
            2+ ran out of time                              -> limit = 3 x p90, 15-60 s, in 5 s steps
  speed     effort above low, 20+ prompts, none guarded,
            median over 5 s                                 -> effort one step down
  skip      8+ prompts just over the word minimum came back
            unchanged 75%+ of the time                      -> word minimum + 1 (at most 10)
  unskip    8+ prompts at the word minimum were all but
            never unchanged (10% or less)                   -> word minimum - 1 (at least 3)

Usage: tune.py [--state DIR] [--report]   (default DIR ~/.local/state/prompt-polish)
"""
import collections
import argparse
import json
import math
import pathlib
import statistics
import time

DEFAULTS = {"effort": "low", "minWords": 4, "timeoutMs": 60_000}
EFFORTS = ["low", "medium", "high"]
KEEP = 500
POLISHED = {"rewritten", "unchanged", "guarded"}


def load(state):
    f = state / "tuning.json"
    try:
        t = json.loads(f.read_text())
    except (OSError, ValueError):
        t = {}
    return {**DEFAULTS, "history": [], **t}


def events(state):
    """The events, oldest first; all but the newest KEEP are deleted."""
    folder = state / "events"
    files = sorted(folder.glob("*.json"), key=lambda p: p.name) if folder.is_dir() else []
    for old in files[:-KEEP]:
        old.unlink(missing_ok=True)
    out = []
    for p in files[-KEEP:]:
        try:
            out.append({**json.loads(p.read_text()), "name": p.name})
        except (OSError, ValueError):
            pass
    return out


def since_change(t, evs):
    """The events written after the last change: a change is judged only on prompts sent under it."""
    after = t["history"][-1].get("after", "") if t["history"] else ""
    return [e for e in evs if e["name"] > after]


def p90(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, math.ceil(0.9 * len(xs)) - 1)]


def decide(t, evs):
    """The one change the numbers call for, as (key, value, reason), or None."""
    win = since_change(t, evs)
    polished = [e for e in win if e.get("outcome") in POLISHED]
    guarded = [e for e in polished if e["outcome"] == "guarded"]
    effort = t["effort"] if t["effort"] in EFFORTS else "low"
    step = EFFORTS.index(effort)

    if len(polished) >= 8 and len(guarded) >= 2 and len(guarded) / len(polished) >= 0.15 and step < len(EFFORTS) - 1:
        why = "; ".join(sorted({e.get("guard", "?") for e in guarded})[:3])
        return "effort", EFFORTS[step + 1], f"{len(guarded)} of {len(polished)} rewrites were refused ({why})"

    timed = [e["ms"] for e in win if e.get("outcome") != "failed" and isinstance(e.get("ms"), (int, float))]
    if len(timed) >= 10:
        target = min(60_000, max(15_000, math.ceil(3 * p90(timed) / 5000) * 5000))
        timeouts = sum(e.get("outcome") == "timeout" for e in win)
        # Down only once a straggler made the user wait past it; up only when rewrites hit the limit
        if target < t["timeoutMs"] and max(timed) > target:
            return "timeoutMs", target, f"90% of {len(timed)} rewrites took {p90(timed) / 1000:.1f} s or less, one {max(timed) / 1000:.0f} s"
        if target > t["timeoutMs"] and timeouts >= 2:
            return "timeoutMs", target, f"{timeouts} of {len(timed)} rewrites ran out of time"

    if step > 0 and len(polished) >= 20 and not guarded:
        median = statistics.median(e["ms"] for e in polished)
        if median > 5000:
            return "effort", EFFORTS[step - 1], f"{len(polished)} rewrites with none refused, median {median / 1000:.1f} s"

    m = t["minWords"]
    near = [e for e in polished if m <= e.get("words", 0) < m + 3]
    if len(near) >= 8 and m < 10:
        same = sum(e["outcome"] == "unchanged" for e in near) / len(near)
        if same >= 0.75:
            return "minWords", m + 1, f"{same:.0%} of {len(near)} prompts of {m}-{m + 2} words needed no change"
    edge = [e for e in polished if m <= e.get("words", 0) <= m + 1]
    if len(edge) >= 8 and m > 3:
        same = sum(e["outcome"] == "unchanged" for e in edge) / len(edge)
        if same <= 0.10:
            return "minWords", m - 1, f"{1 - same:.0%} of {len(edge)} prompts of {m}-{m + 1} words needed a change"
    return None


def report(state, t, evs):
    win = since_change(t, evs)
    by = {}
    for e in evs:
        by[e.get("outcome", "?")] = by.get(e.get("outcome", "?"), 0) + 1
    ms = [e["ms"] for e in evs if e.get("outcome") in POLISHED]
    try:
        ran = (state / "last-run").read_text().strip()
    except OSError:
        ran = "never"
    lines = [f"tuner last ran: {ran}", f"settings: effort {t['effort']}, skip under {t['minWords']} words, time limit {t['timeoutMs'] / 1000:.0f} s",
             f"prompts: {len(evs)} ({', '.join(f'{k} {v}' for k, v in sorted(by.items())) or 'none'}); {len(win)} since the last change"]
    if ms:
        lines.append(f"time: median {statistics.median(ms) / 1000:.1f} s, p90 {p90(ms) / 1000:.1f} s")
    fixed = [e["repaired"].split(" ")[0] for e in evs if e.get("repaired")]
    if fixed:
        kinds = ", ".join(f"{k} {v}" for k, v in sorted(collections.Counter(fixed).items()))
        lines.append(f"repaired: {len(fixed)} refused rewrites fixed by one more call ({kinds})")
    hedged = [e["hedged"] for e in evs if e.get("hedged")]
    if hedged:
        lines.append(f"hedged: {len(hedged)} slow calls got a second call, which answered first in {hedged.count('won')}")
    for e in [e for e in evs if e.get("outcome") == "guarded"][-3:]:
        lines.append(f"refused: {e.get('guard')}: {e.get('original', '')[:80]!r}")
    for h in t["history"][-5:]:
        lines.append(f"changed {time.strftime('%d %b %H:%M', time.localtime(h['at'] / 1000))}: {h['change']} ({h['reason']})")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--state", type=pathlib.Path, default=pathlib.Path.home() / ".local/state/prompt-polish")
    ap.add_argument("--report", action="store_true", help="print the numbers and the last changes; change nothing")
    a = ap.parse_args(argv)
    t, evs = load(a.state), events(a.state)
    if a.report:
        print(report(a.state, t, evs))
        return 0
    a.state.mkdir(parents=True, exist_ok=True)
    (a.state / "last-run").write_text(time.strftime("%Y-%m-%d %H:%M:%S\n"))
    change = decide(t, evs)
    if change is None:
        return 0
    key, value, reason = change
    text = f"{key} {t[key]} -> {value}"
    t[key] = value
    t["history"] = (t["history"] + [{"at": int(time.time() * 1000), "after": evs[-1]["name"], "change": text, "reason": reason}])[-50:]
    a.state.mkdir(parents=True, exist_ok=True)
    tmp = a.state / "tuning.json.tmp"
    tmp.write_text(json.dumps(t, indent=1))
    tmp.replace(a.state / "tuning.json")
    print(f"{text}: {reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
