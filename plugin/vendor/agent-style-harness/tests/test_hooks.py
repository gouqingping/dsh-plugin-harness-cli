import shutil
import tempfile
import unittest
from pathlib import Path

from harness_style import hooks
from harness_style.config import load

from .helpers import CLI, make_repo


class HooksTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = make_repo(self.tmp / "repo")
        self.config = load(self.repo / "harness-style.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_install_sets_hookspath_and_manifest(self):
        written = hooks.install(self.config, CLI)
        self.assertEqual(len(written), 2)
        self.assertTrue((self.repo / ".githooks" / "pre-commit").is_file())
        self.assertTrue(
            (self.repo / ".harness-style" / "hooks.json").is_file())
        self.assertEqual(hooks.verify(self.config), [])

    def test_install_is_idempotent(self):
        hooks.install(self.config, CLI)
        hooks.install(self.config, CLI, force=True)
        self.assertEqual(hooks.verify(self.config), [])

    def test_tampering_detected(self):
        hooks.install(self.config, CLI)
        target = self.repo / ".githooks" / "pre-commit"
        target.write_text(target.read_text() + "\n# 后门\n", encoding="utf-8")
        problems = hooks.verify(self.config)
        self.assertTrue(any("被修改" in p for p in problems), problems)

    def test_uninstall_removes_files_and_config(self):
        hooks.install(self.config, CLI)
        hooks.uninstall(self.config)
        self.assertFalse((self.repo / ".githooks" / "pre-commit").is_file())
        self.assertEqual(hooks.verify(self.config)[0][:10], "core.hooks")

    def test_refuses_foreign_hookspath_without_force(self):
        import subprocess

        subprocess.run(
            ["git", "config", "--local", "core.hooksPath", ".myhooks"],
            cwd=str(self.repo),
            check=True,
        )
        from harness_style.util import ToolError

        with self.assertRaises(ToolError):
            hooks.install(self.config, CLI)
        hooks.install(self.config, CLI, force=True)
        self.assertEqual(hooks.verify(self.config), [])


if __name__ == "__main__":
    unittest.main()
