from django.urls import include, path

urlpatterns = [path("__ticketshot/", include("ticketshot.urls"))]
