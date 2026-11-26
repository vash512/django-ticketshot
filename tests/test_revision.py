"""Reviewed system commit comes from configuration or .git, never environment."""
import tempfile
from pathlib import Path

from django.test import SimpleTestCase

from ticketshot import revision

SHA = "0123456789abcdef0123456789abcdef01234567"


class GitReadingTests(SimpleTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ticketshot-git-"))
        self.git = self.tmp / ".git"
        self.git.mkdir()

    def write(self, relative, text):
        path = self.git / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_branch_with_a_loose_ref(self):
        self.write("HEAD", "ref: refs/heads/staging\n")
        self.write("refs/heads/staging", SHA + "\n")
        self.assertEqual(revision.read_git(self.tmp),
                         {"commit": SHA, "branch": "staging", "source": ".git"})

    def test_detached_head(self):
        self.write("HEAD", SHA + "\n")
        self.assertEqual(revision.read_git(self.tmp)["commit"], SHA)

    def test_packed_refs(self):
        self.write("HEAD", "ref: refs/heads/main\n")
        self.write("packed-refs", f"# pack-refs\n{SHA} refs/heads/main\n")
        self.assertEqual(revision.read_git(self.tmp)["commit"], SHA)

    def test_worktree_points_to_the_common_dir(self):
        common = self.git
        self.write("refs/heads/feature", SHA + "\n")
        worktree_git = common / "worktrees" / "wt"
        worktree_git.mkdir(parents=True)
        (worktree_git / "HEAD").write_text("ref: refs/heads/feature\n", encoding="utf-8")
        (worktree_git / "commondir").write_text("../..\n", encoding="utf-8")
        checkout = self.tmp / "wt"
        checkout.mkdir()
        (checkout / ".git").write_text(f"gitdir: {worktree_git}\n", encoding="utf-8")
        self.assertEqual(revision.read_git(checkout),
                         {"commit": SHA, "branch": "feature", "source": ".git"})

    def test_no_git_is_empty(self):
        self.assertEqual(revision.read_git(self.tmp / "nada"), {})
