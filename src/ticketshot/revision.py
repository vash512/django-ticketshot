"""Version and commit of the reviewed system."""
from functools import lru_cache
from pathlib import Path

from django.conf import settings

from . import conf


def _read(path):
    return Path(path).read_text(encoding="utf-8").strip()


def _git_dir(base):
    """Locate .git, including worktree gitdir files."""
    git = Path(base) / ".git"
    if git.is_file():
        target = Path(_read(git).split(":", 1)[1].strip())
        return target if target.is_absolute() else (Path(base) / target).resolve()
    return git


def _common_dir(git_dir):
    marker = git_dir / "commondir"
    if marker.exists():
        return (git_dir / _read(marker)).resolve()
    return git_dir


def _packed(common, ref):
    packed = common / "packed-refs"
    if not packed.exists():
        return ""
    for line in packed.read_text(encoding="utf-8").splitlines():
        if line.endswith(" " + ref):
            return line.partition(" ")[0]
    return ""


def _commit_of(git_dir, ref):
    common = _common_dir(git_dir)
    for root in (git_dir, common):
        if (root / ref).exists():
            return _read(root / ref)
    return _packed(common, ref)


def read_git(base):
    """Read commit, branch, and source from .git, or return an empty dict."""
    try:
        git_dir = _git_dir(base)
        head = _read(git_dir / "HEAD")
        if not head.startswith("ref:"):
            return {"commit": head[:40], "branch": "", "source": ".git"}
        ref = head.split(":", 1)[1].strip()
        return {"commit": _commit_of(git_dir, ref)[:40],
                "branch": ref.removeprefix("refs/heads/"), "source": ".git"}
    except (OSError, IndexError):
        return {}


@lru_cache(maxsize=4)
def _git_of(base):
    return read_git(base)


def revision():
    value = conf.current().revision
    if callable(value):
        return value()
    if isinstance(value, dict):
        return value
    if value:
        return {"commit": value, "branch": "", "source": "settings"}
    base = getattr(settings, "BASE_DIR", None)
    return _git_of(str(base)) if base else {}


def app_version():
    value = conf.current().app_version
    if callable(value):
        return str(value())
    return value or str(getattr(settings, "APP_VERSION", "") or "")
