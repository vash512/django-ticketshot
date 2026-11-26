"""Include these URLs under a project-specific prefix."""
from django.urls import path

from . import api, panel

app_name = "ticketshot"

urlpatterns = [
    path("tickets/", api.ticket_create, name="ticket_create"),
    path("tickets/open/", api.tickets_open, name="tickets_open"),
    path("tickets/<str:key>/action/", api.ticket_action, name="ticket_action"),
    path("images/<int:pk>/", api.image_view, name="image"),
    path("panel/", panel.panel, name="panel"),
    path("panel/queue/", panel.panel_queue, name="panel_queue"),
    path("panel/<str:key>/", panel.panel_detail, name="panel_detail"),
    path("panel/<str:key>/debug/<int:pk>/", panel.panel_debug, name="panel_debug"),
]
