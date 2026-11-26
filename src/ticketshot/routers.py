"""Route ticket models to their own database alias."""
from . import conf

APP_LABEL = "ticketshot"


def _own(model):
    return model._meta.app_label == APP_LABEL


class TicketShotRouter:
    def db_for_read(self, model, **hints):
        return conf.database() if _own(model) else None

    def db_for_write(self, model, **hints):
        return conf.database() if _own(model) else None

    def allow_relation(self, obj1, obj2, **hints):
        own = (_own(obj1), _own(obj2))
        if all(own):
            return True
        if any(own) and conf.database() != "default":
            return False
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        alias = conf.database()
        if app_label == APP_LABEL:
            return db == alias
        if alias != "default" and db == alias:
            # No other models belong in the ticket database.
            return False
        return None
