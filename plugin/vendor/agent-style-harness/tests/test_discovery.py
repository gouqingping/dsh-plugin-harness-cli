import json
import shutil
import tempfile
import unittest
from pathlib import Path

from harness_style import discovery
from harness_style.config import load

from .helpers import make_repo, write


class DiscoveryTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = make_repo(
            self.tmp / "repo",
            config={
                "languages": {
                    "python": {
                        "enabled": True
                    },
                    "typescript": {
                        "enabled": False
                    }
                }
            },
        )
        self.config = load(self.repo / "harness-style.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_language_mapping(self):
        self.assertEqual(discovery.language_for(Path("a.py")), "python")
        self.assertEqual(discovery.language_for(Path("a.ts")), "typescript")
        self.assertEqual(discovery.language_for(Path("a.h")), "cpp")
        self.assertIsNone(discovery.language_for(Path("a.txt")))

    def test_grouping_respects_enabled_and_exclude(self):
        write(self.repo / "ok.py", "x = 1\n")
        write(self.repo / "skip.ts", "const a = 1;\n")
        write(self.repo / "vendor" / "lib.py", "x=1\n")

        grouped = discovery.group_by_language(
            self.config, ["ok.py", "skip.ts", "vendor/lib.py", "readme.md"])
        self.assertEqual(list(grouped.keys()), ["python"])
        self.assertEqual([p.name for p in grouped["python"]], ["ok.py"])

    def test_paths_scope_walks_directories(self):
        write(self.repo / "pkg" / "a.py", "x = 1\n")
        write(self.repo / "pkg" / "b.txt", "x\n")
        grouped = discovery.resolve(self.config, "paths",
                                    [str(self.repo / "pkg")])
        self.assertEqual([p.name for p in grouped["python"]], ["a.py"])

    def test_unknown_extension_ignored(self):
        write(self.repo / "notes.md", "# hi\n")
        grouped = discovery.resolve(self.config, "paths", [str(self.repo)])
        self.assertEqual(grouped, {})


if __name__ == "__main__":
    unittest.main()
