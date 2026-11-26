"""Access decisions for the review bar and tickets."""
from . import conf, states


def _active(user):
    return bool(user and getattr(user, "is_authenticated", False)
                and getattr(user, "is_active", False))


class BasePermissions:
    """Permission interface; subclasses override the _can_* methods."""

    def can_add(self, user):
        """Whether the user can create tickets."""
        return _active(user) and self._can_add(user)

    def can_view(self, user):
        """Whether the user can view the panel, tickets, and images."""
        return _active(user) and self._can_view(user)

    def can_comment(self, user):
        """Whether the user can comment on tickets."""
        return _active(user) and self._can_comment(user)

    def can_work(self, user):
        """Whether the user can move statuses and edit reproducible URLs."""
        return _active(user) and self._can_work(user)

    def can_approve(self, user):
        """Whether the user can approve or reject tickets."""
        return _active(user) and self._can_approve(user)

    def can_debug(self, user):
        """Whether the user can view debug records."""
        return _active(user) and self._can_debug(user)

    def show_bar(self, request):
        """Show the bar only to active signed-in users."""
        return _active(request.user) and self._show_bar(request)

    def _show_bar(self, request):
        """By default, show the bar to users who can create tickets."""
        return self.can_add(request.user)

    # Deny permissions not defined by a subclass.
    def _can_add(self, user):
        return False

    def _can_view(self, user):
        return False

    def _can_comment(self, user):
        return False

    def _can_work(self, user):
        return False

    def _can_approve(self, user):
        return False

    def _can_debug(self, user):
        return False


class StaffPermissions(BasePermissions):
    """Permissions from user attributes without database queries."""

    def _can_add(self, user):
        return bool(user.is_superuser or user.is_staff)

    def _can_view(self, user):
        return bool(user.is_superuser)

    def _can_comment(self, user):
        return bool(user.is_superuser or user.is_staff)

    def _can_work(self, user):
        return bool(user.is_superuser)

    def _can_approve(self, user):
        return bool(user.is_superuser)

    def _can_debug(self, user):
        return bool(user.is_superuser)


class ModelPermissions(BasePermissions):
    """Django model permissions stored in the primary user database."""

    def _has(self, user, codename):
        return user.has_perm(f"ticketshot.{codename}")

    def _can_add(self, user):
        return self._has(user, "add_ticket")

    def _can_view(self, user):
        return self._has(user, "view_ticket")

    def _can_comment(self, user):
        return self._can_add(user) or self._can_view(user)

    def _can_work(self, user):
        return self._has(user, "change_ticket")

    def _can_approve(self, user):
        return self._has(user, "approve_ticket")

    def _can_debug(self, user):
        return self._has(user, "view_debug")


def show_bar(request):
    """Configured bar visibility, subject to ENABLED."""
    return conf.current().enabled and bool(conf.permissions().show_bar(request))


def can_add(user):
    return conf.permissions().can_add(user)


def can_view(user):
    return conf.permissions().can_view(user)


def can_comment(user):
    return conf.permissions().can_comment(user)


def can_work(user):
    return conf.permissions().can_work(user)


def can_approve(user):
    return conf.permissions().can_approve(user)


def can_debug(user):
    return conf.permissions().can_debug(user)


def flags(user):
    """Flags the bar and panel need for this user."""
    return {
        "view": can_view(user),
        "comment": can_comment(user),
        "work": can_work(user),
        "approve": can_approve(user),
        "debug": can_debug(user),
    }


def can_do(user, action):
    """Whether a user may perform a states.Action on a ticket."""
    flag = states.PERMISSION.get(action)
    return bool(flag) and flags(user)[flag]
