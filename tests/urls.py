from django.contrib import admin
from django.contrib.auth.models import Group
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.urls import include, path
from django.views.decorators.csrf import csrf_exempt


def page(request, pk=None, email=None):
    return render(request, "page.html", {"pk": pk})


@csrf_exempt
def save(request):
    """Write to the primary database for debug recording."""
    Group.objects.create(name=f"grupo-{request.POST.get('nombre', 'x')}")
    return render(request, "page.html", {"pk": 1, "nombre": request.POST.get("nombre")})


def boom(request):
    return 1 / 0


def many_queries(request):
    for i in range(60):
        list(Group.objects.filter(name=f"consulta-larga-{'x' * 40}-{i}"))
    return render(request, "page.html", {"pk": 2})


def go(request):
    from django.shortcuts import redirect
    return redirect("/page/?q=valor-escrito")


def secret_lookup(request):
    """Issue a query whose SQL names a sensitive column."""
    from django.contrib.auth import get_user_model
    list(get_user_model().objects.filter(password="contraseña-secreta"))
    return render(request, "page.html", {"pk": 3})


def touches_tickets(request):
    """Read both databases; recording sees only the primary one."""
    from ticketshot.models import Ticket
    Ticket.objects.count()
    Group.objects.count()
    return render(request, "page.html", {"pk": 4})


def two_bodies(request):
    """Put a body end tag inside a script; inject before the last one."""
    return HttpResponse("<html><body><script>var s = '</body>';</script><p>fin</p></body></html>")


def fragment(request):
    return HttpResponse("<div>sin cuerpo</div>")


def data(request):
    return JsonResponse({"ok": True})


urlpatterns = [
    path("admin/", admin.site.urls),
    path("__ticketshot/", include("ticketshot.urls")),
    path("page/", page, name="page"),
    path("item/<int:pk>/", page, name="item"),
    path("u/<str:email>/", page, name="user_email"),
    path("save/", save, name="save"),
    path("boom/", boom, name="boom"),
    path("many-queries/", many_queries, name="many_queries"),
    path("fragment/", fragment, name="fragment"),
    path("secret-lookup/", secret_lookup, name="secret_lookup"),
    path("go/", go, name="go"),
    path("touches-tickets/", touches_tickets, name="touches_tickets"),
    path("two-bodies/", two_bodies, name="two_bodies"),
    path("data/", data, name="data"),
]
