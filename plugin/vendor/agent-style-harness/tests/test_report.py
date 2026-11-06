import json
import unittest

from harness_style import report
from harness_style.violation import Result, Violation


def sample():
    result = Result(scope="staged", files_checked=2)
    result.engines = {"yapf": "0.43.0"}
    result.violations = [
        Violation(
            engine="yapf",
            code="format",
            file="a.py",
            line=3,
            severity="error",
            fixable=True,
            message="格式不符",
            doc="https://example/doc",
        ),
        Violation(
            engine="isort",
            code="import-order",
            file="b.py",
            line=1,
            severity="warning",
            message="import 顺序",
        ),
    ]
    return result


class ReportTest(unittest.TestCase):

    def test_json_schema(self):
        payload = report.to_payload(sample())
        self.assertEqual(payload["schema"], "harness-style/v1")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["summary"]["errors"], 1)
        self.assertEqual(payload["summary"]["warnings"], 1)
        self.assertEqual(payload["summary"]["fixable"], 1)
        self.assertEqual(payload["env"]["engines"], {"yapf": "0.43.0"})
        self.assertEqual(payload["violations"][0]["doc"],
                         "https://example/doc")

    def test_json_is_valid_json(self):
        self.assertIsInstance(json.loads(report.render_json(sample())), dict)

    def test_ok_when_only_warnings(self):
        result = sample()
        result.violations = [
            v for v in result.violations if v.severity == "warning"
        ]
        self.assertTrue(report.to_payload(result)["ok"])

    def test_human_mentions_fix_hint(self):
        text = report.render_human(sample())
        self.assertIn("harness-style fix", text)
        self.assertIn("a.py", text)
        self.assertIn("规范依据", text)


if __name__ == "__main__":
    unittest.main()
