import io
import json
import pathlib
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tune  # noqa: E402


class Tune(unittest.TestCase):
    def setUp(self):
        self.state = pathlib.Path(tempfile.mkdtemp())
        (self.state / "events").mkdir()
        self.n = 0

    def ev(self, outcome="rewritten", ms=3000, words=12, **kw):
        self.n += 1
        at = 10**12 + self.n
        (self.state / "events" / f"{at}-x.json").write_text(json.dumps({"at": at, "words": words, "ms": ms, "effort": "low", "outcome": outcome, **kw}))

    def run_tuner(self):
        out = io.StringIO()
        with redirect_stdout(out):
            tune.main(["--state", str(self.state)])
        return out.getvalue().strip()

    def settings(self):
        return json.loads((self.state / "tuning.json").read_text())

    def test_healthy_numbers_change_nothing(self):
        for _ in range(30):
            self.ev(ms=4000)
        self.assertEqual(self.run_tuner(), "")
        self.assertFalse((self.state / "tuning.json").exists())
        self.assertTrue((self.state / "last-run").exists())  # it ran, and said so where the report reads it

    def test_refused_rewrites_raise_effort_once_then_wait_for_new_prompts(self):
        for i in range(10):
            self.ev("guarded" if i < 3 else "rewritten", guard="lost src/a.ts")
        self.assertIn("effort low -> medium", self.run_tuner())
        self.assertEqual(self.settings()["effort"], "medium")
        self.assertEqual(self.run_tuner(), "")  # judged again only on prompts sent after the change

    def test_a_straggler_brings_the_time_limit_down_and_timeouts_put_it_up(self):
        for _ in range(11):
            self.ev(ms=4000)
        self.ev(ms=45000)
        self.assertIn("timeoutMs 60000 -> 15000", self.run_tuner())
        for _ in range(8):
            self.ev(ms=9000)
        for _ in range(2):
            self.ev("timeout", ms=15000)
        self.assertIn("timeoutMs 15000 -> 45000", self.run_tuner())

    def test_effort_comes_back_down_when_accurate_but_slow(self):
        (self.state / "tuning.json").write_text(json.dumps({"effort": "medium", "timeoutMs": 30000, "history": []}))
        for _ in range(20):
            self.ev(ms=8000)
        self.assertIn("effort medium -> low", self.run_tuner())

    def test_short_prompts_that_need_nothing_are_skipped(self):
        for _ in range(8):
            self.ev("unchanged", words=5, ms=12000)
        self.assertIn("minWords 4 -> 5", self.run_tuner())

    def test_short_prompts_that_always_need_fixing_are_polished(self):
        (self.state / "tuning.json").write_text(json.dumps({"minWords": 6, "history": []}))
        for _ in range(8):
            self.ev(words=6, ms=12000)
        self.assertIn("minWords 6 -> 5", self.run_tuner())

    def test_keeps_the_newest_events_only(self):
        tune.KEEP, keep = 3, tune.KEEP
        try:
            for _ in range(5):
                self.ev()
            self.assertEqual(len(tune.events(self.state)), 3)
            self.assertEqual(len(list((self.state / "events").glob("*.json"))), 3)
        finally:
            tune.KEEP = keep

    def test_report_changes_nothing(self):
        self.ev("guarded", guard="lost --no-checks", original="run deploy --no-checks")
        self.ev("rewritten", repaired="lost src/a.ts")
        self.ev("rewritten", hedged="won")
        self.ev("unchanged", hedged="lost")
        out = io.StringIO()
        with redirect_stdout(out):
            tune.main(["--state", str(self.state), "--report"])
        self.assertIn("refused: lost --no-checks", out.getvalue())
        self.assertIn("repaired: 1 refused rewrites fixed by one more call (lost 1)", out.getvalue())
        self.assertIn("hedged: 2 slow calls got a second call, which answered first in 1", out.getvalue())
        self.assertFalse((self.state / "tuning.json").exists())


if __name__ == "__main__":
    unittest.main()
