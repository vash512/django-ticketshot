from django.apps import AppConfig


class TicketShotConfig(AppConfig):
    name = "ticketshot"
    verbose_name = "Review tickets"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from . import autoconfig, checks  # noqa: F401  (checks registers system checks)
        from .debuglog import install_signal_receivers
        from .pagecontext import install_template_tracking

        autoconfig.install()
        install_template_tracking()
        install_signal_receivers()
