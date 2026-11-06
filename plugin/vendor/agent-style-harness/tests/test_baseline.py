import json
import shutil
import tempfile
import unittest
from pathlib import Path

from harness_style import baseline
from harness_style.config import load
from harness_style.violation import Violation

from .helpers import make_repo


class BaselineTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = make_repo(self.tmp / "repo")
        self.config = load(self.repo / "harness-style.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _v(self, path="a.py", code="format", engine="yapf"):
        return Violation(engine=engine, code=code, file=path, message="x")

    def test_no_baseline_passes_everything_through(self):
        remaining, suppressed = baseline.apply(
            self.config, [self._v(), self._v()])
        self.assertEqual(len(remaining), 2)
        self.assertEqual(suppressed, 0)

    def test_suppresses_only_up_to_recorded_count(self):
        baseline.write(self.config, [self._v()])
        remaining, suppressed = baseline.apply(
            self.config,
            [self._v(), self._v(), self._v()])
        self.assertEqual(suppressed, 1)
        self.assertEqual(len(remaining), 2)

    def test_different_code_not_suppressed(self):
        baseline.write(self.config, [self._v(code="format")])
        remaining, suppressed = baseline.apply(self.config,
                                               [self._v(code="import-order")])
        self.assertEqual(suppressed, 0)
        self.assertEqual(len(remaining), 1)

    def test_corrupt_baseline_is_tool_error(self):
        path = baseline.path_for(self.config)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        from harness_style.util import ToolError

        with self.assertRaises(ToolError):
            baseline.load(self.config)

    def test_file_shape(self):
        baseline.write(self.config, [self._v()])
        payload = json.loads(baseline.path_for(self.config).read_text())
        self.assertEqual(payload["version"], 1)
        self.assertIn("a.py|yapf|format", payload["counts"])


if __name__ == "__main__":
    unittest.main()
