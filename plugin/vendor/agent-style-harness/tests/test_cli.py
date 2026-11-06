import json
import shutil
import tempfile
import unittest
from pathlib import Path

from .helpers import cli, make_repo, write


class CliTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = make_repo(self.tmp / "repo")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_check_with_no_files_is_ok(self):
        proc = cli("check", "--staged", cwd=self.repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("没有需要检查的文件", proc.stdout)

    def test_json_output_schema(self):
        proc = cli("check", "--all", "--json", cwd=self.repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["schema"], "harness-style/v1")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["env"]["offline"], True)

    def test_missing_engine_is_tool_error_not_violation(self):
        repo = make_repo(
            self.tmp / "java",
            config={
                "languages": {
                    "java": {
                        "enabled": True,
                        "engine": "google-java-format"
                    }
                }
            },
        )
        write(repo / "Main.java", "class Main {}\n")
        proc = cli("check", "--all", cwd=repo)
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("java", proc.stderr)

    def test_commit_msg_empty_rejected(self):
        write(self.repo / "msg.txt", "# 只有注释\n\n")
        proc = cli("commit-msg", "msg.txt", cwd=self.repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("为空", proc.stderr)

    def test_commit_msg_merge_skipped(self):
        write(self.repo / "msg.txt", "Merge branch 'main' into feature\n")
        proc = cli("commit-msg", "msg.txt", cwd=self.repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_commit_msg_revert_skipped(self):
        write(self.repo / "msg.txt",
              'Revert "feat: x"\n\nThis reverts commit abc.\n')
        proc = cli("commit-msg", "msg.txt", cwd=self.repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_fixup_outside_rebase_rejected(self):
        write(self.repo / "msg.txt", "fixup! feat: x\n")
        proc = cli("commit-msg", "msg.txt", cwd=self.repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("rebase", proc.stderr)

    def test_commitlint_pass_and_fail(self):
        fake = write(
            self.repo / "fake-commitlint.js",
            "let d='';process.stdin.on('data',c=>d+=c);"
            "process.stdin.on('end',()=>{"
            "const h=d.split('\\n')[0];"
            "if(h.startsWith('feat')){process.exit(0)}"
            "console.error('x type must be feat');process.exit(1)});\n",
        )
        config = json.loads((self.repo / "harness-style.json").read_text())
        config["commitlint"] = {"cli": str(fake)}
        (self.repo / "harness-style.json").write_text(json.dumps(config))
        write(self.repo / "commitlint.config.cjs",
              "module.exports = {rules: {}};\n")

        write(self.repo / "msg.txt", "feat: ok\n")
        proc = cli("commit-msg", "msg.txt", cwd=self.repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        write(self.repo / "msg.txt", "update\n")
        proc = cli("commit-msg", "msg.txt", cwd=self.repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("type must be feat", proc.stderr)


if __name__ == "__main__":
    unittest.main()
