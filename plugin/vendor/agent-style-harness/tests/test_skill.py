import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness_style import skill

from .helpers import make_repo, write


class SkillInstallTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = make_repo(self.tmp / "repo")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_project_scope_layout(self):
        dest = skill.install(self.repo, scope="project")
        self.assertEqual(dest.parent.name, skill.SKILL_NAME)
        self.assertEqual(dest.parent.parent.name, "skills")
        self.assertEqual(dest.parent.parent.parent.name, ".dsh")
        self.assertIn("name: google-style-guard",
                      dest.read_text(encoding="utf-8"))

    def test_project_scope_appends_tool_path(self):
        dest = skill.install(self.repo,
                             scope="project",
                             tool_path=Path("/opt/bin/harness-style"))
        self.assertIn("/opt/bin/harness-style",
                      dest.read_text(encoding="utf-8"))

    def test_user_scope_uses_dsh_home(self):
        home = self.tmp / "dshhome"
        with mock.patch.dict(os.environ, {"DSH_HOME": str(home)}):
            dest = skill.install(self.repo, scope="user")
        self.assertEqual(dest, home / "skills" / skill.SKILL_NAME / "SKILL.md")

    def test_overwrite_false_keeps_existing(self):
        dest = skill.install(self.repo, scope="project")
        dest.write_text("hand edited", encoding="utf-8")
        skill.install(self.repo, scope="project", overwrite=False)
        self.assertEqual(dest.read_text(encoding="utf-8"), "hand edited")


class AgentsUpsertTest(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = make_repo(self.tmp / "repo")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_creates_block(self):
        path, action = skill.upsert_agents(self.repo)
        self.assertEqual(action, "created")
        text = path.read_text(encoding="utf-8")
        self.assertIn(skill.BEGIN, text)
        self.assertIn("harness-style check --staged", text)

    def test_idempotent(self):
        skill.upsert_agents(self.repo)
        path, action = skill.upsert_agents(self.repo)
        self.assertEqual(action, "updated")
        self.assertEqual(
            path.read_text(encoding="utf-8").count(skill.BEGIN), 1)

    def test_preserves_existing_content(self):
        write(self.repo / "AGENTS.md", "# 团队规则\n\n先读 docs。\n")
        path, action = skill.upsert_agents(self.repo)
        self.assertEqual(action, "appended")
        text = path.read_text(encoding="utf-8")
        self.assertIn("# 团队规则", text)
        self.assertIn(skill.BEGIN, text)
        skill.upsert_agents(self.repo)
        self.assertEqual(path.read_text(encoding="utf-8").count("# 团队规则"), 1)


if __name__ == "__main__":
    unittest.main()
