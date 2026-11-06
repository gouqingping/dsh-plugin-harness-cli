import unittest

from harness_style.util import diff_hunks, glob_to_regex, matches_any


class GlobTest(unittest.TestCase):

    def test_double_star(self):
        self.assertTrue(matches_any("a/b/c.py", ["**/vendor/**"]) is False)
        self.assertTrue(matches_any("vendor/x/y.py", ["**/vendor/**"]))
        self.assertTrue(
            matches_any("node_modules/a/index.js", ["**/node_modules/**"]))

    def test_basename_pattern(self):
        self.assertTrue(matches_any("a/b/x.min.js", ["*.min.js"]))
        self.assertFalse(matches_any("a/b/x.js", ["*.min.js"]))

    def test_star_single_segment(self):
        regex = glob_to_regex("src/*.py")
        self.assertTrue(regex.match("src/a.py"))
        self.assertFalse(regex.match("src/sub/a.py"))

    def test_plain_path(self):
        self.assertTrue(matches_any("docs/readme.md", ["docs/readme.md"]))


class DiffTest(unittest.TestCase):

    def test_separate_hunks(self):
        old = "def a( ):\n    pass\n\ndef b( ):\n    pass\n"
        new = "def a():\n    pass\n\ndef b():\n    pass\n"
        self.assertEqual(diff_hunks(old, new), [1, 4])

    def test_identical(self):
        self.assertEqual(diff_hunks("a\n", "a\n"), [])


if __name__ == "__main__":
    unittest.main()
