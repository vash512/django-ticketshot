"""Always announce where commands will write before writing."""
from django.conf import settings
from django.core.management.base import CommandError
from django.utils.translation import gettext as _

from .. import conf


def describe():
    config = conf.current()
    db = settings.DATABASES.get(config.database, {})
    engine = db.get("ENGINE", "").rpartition(".")[2]
    if engine == "sqlite3":
        where = str(db.get("NAME", ""))
    else:
        where = f"{db.get('USER', '')}@{db.get('HOST', '')}:{db.get('PORT', '')}/{db.get('NAME', '')}"
    return {"alias": config.database, "engine": engine, "where": where,
            "remote": engine != "sqlite3", "project": config.project, "storage": config.storage}


def line(info=None):
    info = info or describe()
    return _("Destination: project “%(project)s” in database “%(alias)s” "
             "(%(engine)s %(where)s), images in “%(storage)s” mode.") % info


def require_yes(command, yes, info=None):
    info = info or describe()
    command.stdout.write(line(info))
    if info["remote"] and not yes:
        raise CommandError(_("The ticket database is shared (remote); repeat with --yes to write."))
