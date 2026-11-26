"""Actor identity without foreign keys across databases."""
from dataclasses import dataclass

USERNAME_MAX = 150
LABEL_MAX = 200


def is_authenticated(user):
    return bool(getattr(user, "is_authenticated", False))


def label(user):
    """Return full name and username, username alone, or empty for anonymous."""
    if not is_authenticated(user):
        return ""
    full = user.get_full_name() if hasattr(user, "get_full_name") else ""
    name = user.get_username()
    return f"{full} ({name})" if full else name


@dataclass(frozen=True)
class Actor:
    username: str
    label: str

    @classmethod
    def from_user(cls, user):
        if not is_authenticated(user):
            return cls("", "")
        return cls(user.get_username()[:USERNAME_MAX], label(user)[:LABEL_MAX])

    @classmethod
    def named(cls, label_text, username=""):
        return cls(str(username or "")[:USERNAME_MAX], str(label_text or "")[:LABEL_MAX])


def summary(user):
    """Return user details without database queries for each page."""
    if not is_authenticated(user):
        return {"authenticated": False}
    return {
        "authenticated": True,
        "id": user.pk,
        "username": user.get_username(),
        "full_name": (user.get_full_name() or "") if hasattr(user, "get_full_name") else "",
        "is_staff": bool(getattr(user, "is_staff", False)),
        "is_superuser": bool(getattr(user, "is_superuser", False)),
    }


def group_names(user, limit=30):
    """Fetch group names once when creating a ticket, not on every page."""
    if not is_authenticated(user) or not hasattr(user, "groups"):
        return []
    return sorted(user.groups.values_list("name", flat=True))[:limit]
