import { describe, expect, it } from 'vitest';
import { emptyProjectConfig, type GraphIndex, type ProjectConfig } from '../src/index.js';
import { describeNode, memoryIndex } from './fixture.js';

/** Non-structural edges as readable strings, plus IMPORTS (useful across languages). */
function edges(index: GraphIndex): string[] {
  const name = (id: string) => {
    const n = index.store.getNode(id);
    return n ? describeNode(n) : `?${id}`;
  };
  return [...index.store.edges()]
    .filter((e) => e.kind !== 'CONTAINS' && e.kind !== 'EXPORTS')
    .map((e) => `${e.kind} ${name(e.source)} -> ${name(e.target)}`)
    .sort();
}

const build = (files: Record<string, string>, config: Partial<ProjectConfig> = {}) => memoryIndex(files, { ...emptyProjectConfig(), ...config });

describe('Python', () => {
  const files = {
    'app/__init__.py': '',
    'app/models.py': `from django.db import models\n\nclass Customer(models.Model):\n    name = models.CharField(max_length=80)\n\nclass Order(models.Model):\n    """A placed order."""\n    customer = models.ForeignKey("Customer", on_delete=models.CASCADE)\n    total = models.IntegerField()\n`,
    'app/repositories/__init__.py': '',
    'app/repositories/order_repository.py': `from app.models import Order\n\nclass OrderRepository:\n    def find(self, order_id: int) -> Order:\n        return Order.objects.get(id=order_id)\n\n    def save(self, order: Order) -> None:\n        order.save()\n`,
    'app/services/__init__.py': `from .order_service import OrderService\n`,
    'app/services/order_service.py': `import stripe\nimport requests\nfrom openai import OpenAI\nfrom app.repositories.order_repository import OrderRepository\n\nclass OrderService:\n    """Checks out orders."""\n    def __init__(self, repo: OrderRepository):\n        self.repo = repo\n        self.ai = OpenAI()\n\n    def checkout(self, order_id: int):\n        order = self.repo.find(order_id)\n        stripe.Charge.create(amount=order.total)\n        self.ai.chat.completions.create(model="gpt")\n        requests.get("https://api.github.com/repos/acme/shop")\n        return order\n`,
    'app/api.py': `from fastapi import APIRouter\nfrom app.services import OrderService\nfrom app.repositories.order_repository import OrderRepository\n\nrouter = APIRouter(prefix="/api/orders")\n\n@router.post("/{order_id}/checkout")\ndef checkout(order_id: int):\n    svc = OrderService(OrderRepository())\n    return svc.checkout(order_id)\n`,
  };

  it('resolves modules, packages, self fields, routes, models and SDKs', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS api_route:POST /api/orders/:order_id/checkout -> app/api.py#checkout');
    expect(e).toContain('CALLS app/api.py#checkout -> app/services/order_service.py#OrderService.checkout');
    expect(e).toContain('CALLS app/services/order_service.py#OrderService.checkout -> app/repositories/order_repository.py#OrderRepository.find');
    expect(e).toContain('READS_FROM app/repositories/order_repository.py#OrderRepository.find -> database_model:Order');
    expect(e).toContain('WRITES_TO app/repositories/order_repository.py#OrderRepository.save -> database_model:Order');
    expect(e).toContain('USES app/services/order_service.py#OrderService.checkout -> external_service:Stripe');
    expect(e).toContain('USES app/services/order_service.py#OrderService.checkout -> external_service:OpenAI');
    expect(e).toContain('HTTP_CALL app/services/order_service.py#OrderService.checkout -> external_service:GitHub API');
    expect(e).toContain('DEPENDS_ON database_model:Order -> database_model:Customer');
    expect(e).toContain('IMPORTS app/services/__init__.py -> app/services/order_service.py');
    expect(e).toContain('IMPORTS app/api.py -> app/services/__init__.py');
  });

  it('resolves relative imports, from-package submodules and Flask blueprints', async () => {
    const e = edges(
      await build({
        'shop/__init__.py': '',
        'shop/billing/__init__.py': '',
        'shop/billing/invoices.py': `def render(order):\n    return str(order)\n`,
        'shop/views.py': `from flask import Blueprint\nfrom .billing import invoices\nfrom . import billing\n\nbp = Blueprint("shop", __name__, url_prefix="/shop")\n\n@bp.route("/invoice/<int:id>", methods=["GET", "POST"])\ndef invoice(id):\n    return invoices.render(id)\n`,
      }),
    );
    expect(e).toContain('CALLS shop/views.py#invoice -> shop/billing/invoices.py#render');
    expect(e).toContain('CALLS api_route:GET /shop/invoice/:id -> shop/views.py#invoice');
    expect(e).toContain('CALLS api_route:POST /shop/invoice/:id -> shop/views.py#invoice');
    expect(e).toContain('IMPORTS shop/views.py -> shop/billing/invoices.py');
  });
});

describe('Go', () => {
  const files = {
    'internal/store/repository.go': `package store\n\n// Repository loads orders.\ntype Repository struct{}\n\nfunc (r *Repository) Find(id string) *Order { return nil }\n`,
    'internal/store/order.go': `package store\n\nimport "gorm.io/gorm"\n\ntype Order struct {\n\tgorm.Model\n\tCustomer Customer\n}\n\ntype Customer struct {\n\tgorm.Model\n}\n\nfunc (r *Repository) Save(o *Order) error { return nil }\n`,
    'internal/order/service.go': `package order\n\nimport (\n\t"github.com/acme/shop/internal/store"\n\t"github.com/stripe/stripe-go/v76/charge"\n)\n\ntype Service struct {\n\trepo *store.Repository\n}\n\nfunc NewService(r *store.Repository) *Service { return &Service{repo: r} }\n\n// Checkout charges and saves an order.\nfunc (s *Service) Checkout(id string) error {\n\to := s.repo.Find(id)\n\tcharge.New(nil)\n\ts.repo.Save(o)\n\treturn validate(o)\n}\n`,
    'internal/order/validate.go': `package order\n\nfunc validate(o any) error { return nil }\n`,
    'cmd/api/main.go': `package main\n\nimport (\n\t"net/http"\n\n\t"github.com/acme/shop/internal/order"\n\t"github.com/acme/shop/internal/store"\n)\n\nfunc main() {\n\tsvc := order.NewService(&store.Repository{})\n\thttp.HandleFunc("POST /orders/{id}/checkout", checkout)\n\tsvc.Checkout("1")\n}\n\nfunc checkout(w http.ResponseWriter, r *http.Request) {}\n`,
  };
  const config = { goModules: [{ dir: '', path: 'github.com/acme/shop' }] };

  it('resolves packages as directories, receivers, same-package calls and routes', async () => {
    const e = edges(await build(files, config));
    expect(e).toContain('CALLS cmd/api/main.go#main -> internal/order/service.go#NewService');
    expect(e).toContain('CALLS cmd/api/main.go#main -> internal/order/service.go#Service.Checkout');
    expect(e).toContain('CALLS internal/order/service.go#Service.Checkout -> internal/store/repository.go#Repository.Find');
    // A method declared in a different file of the receiver's package.
    expect(e).toContain('CALLS internal/order/service.go#Service.Checkout -> internal/store/order.go#Repository.Save');
    expect(e).toContain('CALLS internal/order/service.go#Service.Checkout -> internal/order/validate.go#validate');
    expect(e).toContain('USES internal/order/service.go#Service.Checkout -> external_service:Stripe');
    expect(e).toContain('CALLS api_route:POST /orders/:id/checkout -> cmd/api/main.go#checkout');
    expect(e).toContain('IMPORTS cmd/api/main.go -> internal/order/service.go');
    expect(e).not.toContain('IMPORTS cmd/api/main.go -> internal/order/validate.go');
    expect(e).toContain('DEPENDS_ON database_model:Order -> database_model:Customer');
  });

  it('falls back to directory suffixes without go.mod', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS cmd/api/main.go#main -> internal/order/service.go#NewService');
  });
});

describe('Java', () => {
  const base = 'src/main/java/com/acme/shop';
  const files = {
    [`${base}/order/Order.java`]: `package com.acme.shop.order;\n\nimport jakarta.persistence.*;\n\n@Entity\npublic class Order {\n  @Id private Long id;\n  @ManyToOne private Customer customer;\n}\n`,
    [`${base}/order/Customer.java`]: `package com.acme.shop.order;\n\n@Entity\npublic class Customer { @Id private Long id; }\n`,
    [`${base}/order/OrderRepository.java`]: `package com.acme.shop.order;\n\npublic interface OrderRepository extends JpaRepository<Order, Long> {\n  Order findByRef(String ref);\n}\n`,
    [`${base}/order/OrderService.java`]: `package com.acme.shop.order;\n\nimport com.acme.shop.payment.PaymentGateway;\n\n/** Checks out orders. */\n@Service\npublic class OrderService {\n  private final OrderRepository repo;\n  private final PaymentGateway payments;\n\n  public OrderService(OrderRepository repo, PaymentGateway payments) {\n    this.repo = repo;\n    this.payments = payments;\n  }\n\n  public Order checkout(String ref) {\n    Order o = repo.findByRef(ref);\n    payments.charge(o);\n    return o;\n  }\n}\n`,
    [`${base}/payment/PaymentGateway.java`]: `package com.acme.shop.payment;\n\nimport com.stripe.model.Charge;\n\npublic class PaymentGateway {\n  public void charge(Object o) {\n    Charge.create(null);\n  }\n}\n`,
    [`${base}/web/OrderController.java`]: `package com.acme.shop.web;\n\nimport com.acme.shop.order.*;\n\n@RestController\n@RequestMapping("/api/orders")\npublic class OrderController {\n  private final OrderService service;\n\n  public OrderController(OrderService service) { this.service = service; }\n\n  @PostMapping("/{ref}/checkout")\n  public Order checkout(@PathVariable String ref) {\n    return service.checkout(ref);\n  }\n}\n`,
  };

  it('resolves packages, wildcard imports, implicit this, Spring routes and JPA entities', async () => {
    const e = edges(await build(files));
    const c = (s: string) => `${base}/${s}`;
    expect(e).toContain(`CALLS api_route:POST /api/orders/:ref/checkout -> ${c('web/OrderController.java')}#OrderController.checkout`);
    expect(e).toContain(`CALLS ${c('web/OrderController.java')}#OrderController.checkout -> ${c('order/OrderService.java')}#OrderService.checkout`);
    expect(e).toContain(`CALLS ${c('order/OrderService.java')}#OrderService.checkout -> ${c('order/OrderRepository.java')}#OrderRepository.findByRef`);
    expect(e).toContain(`CALLS ${c('order/OrderService.java')}#OrderService.checkout -> ${c('payment/PaymentGateway.java')}#PaymentGateway.charge`);
    expect(e).toContain(`USES ${c('payment/PaymentGateway.java')}#PaymentGateway.charge -> external_service:Stripe`);
    expect(e).toContain('DEPENDS_ON database_model:Order -> database_model:Customer');
    expect(e).toContain(`IMPORTS ${c('web/OrderController.java')} -> ${c('order/OrderService.java')}`);
    expect(e).toContain(`IMPORTS ${c('order/OrderService.java')} -> ${c('payment/PaymentGateway.java')}`);
  });
});

describe('Kotlin', () => {
  const base = 'src/shop';
  const files = {
    [`${base}/order/Order.kt`]: `package shop.order\n\nimport jakarta.persistence.*\n\n@Entity\ndata class Order(\n    @Id val id: Long,\n    @ManyToOne val customer: Customer,\n)\n`,
    [`${base}/order/Customer.kt`]: `package shop.order\n\nimport jakarta.persistence.*\n\n@Entity\nclass Customer {\n    @Id val id: Long = 0\n}\n`,
    [`${base}/order/OrderRepository.kt`]: `package shop.order\n\ninterface OrderRepository {\n    fun findByRef(ref: String): Order\n}\n`,
    [`${base}/order/OrderService.kt`]: `package shop.order\n\nimport shop.payment.PaymentGateway\n\n/** Checks out orders. */\nclass OrderService(private val repo: OrderRepository, private val payments: PaymentGateway) {\n    fun checkout(ref: String): Order {\n        val o = repo.findByRef(ref)\n        payments.charge(o)\n        return o\n    }\n}\n`,
    [`${base}/payment/PaymentGateway.kt`]: `package shop.payment\n\nimport com.stripe.model.Charge\n\nclass PaymentGateway {\n    fun charge(o: Any) {\n        Charge.create(null)\n    }\n}\n`,
    [`${base}/web/OrderController.kt`]: `package shop.web\n\nimport shop.order.OrderService\n\n@RestController\n@RequestMapping("/api/orders")\nclass OrderController(private val service: OrderService) {\n    @PostMapping("/{ref}/checkout")\n    fun checkout(ref: String) = service.checkout(ref)\n}\n`,
  };

  it('resolves packages, constructor injection, Spring routes and JPA entities', async () => {
    const e = edges(await build(files));
    const c = (s: string) => `${base}/${s}`;
    expect(e).toContain(`CALLS api_route:POST /api/orders/:ref/checkout -> ${c('web/OrderController.kt')}#OrderController.checkout`);
    expect(e).toContain(`CALLS ${c('web/OrderController.kt')}#OrderController.checkout -> ${c('order/OrderService.kt')}#OrderService.checkout`);
    expect(e).toContain(`CALLS ${c('order/OrderService.kt')}#OrderService.checkout -> ${c('order/OrderRepository.kt')}#OrderRepository.findByRef`);
    expect(e).toContain(`CALLS ${c('order/OrderService.kt')}#OrderService.checkout -> ${c('payment/PaymentGateway.kt')}#PaymentGateway.charge`);
    expect(e).toContain(`USES ${c('payment/PaymentGateway.kt')}#PaymentGateway.charge -> external_service:Stripe`);
    expect(e).toContain('DEPENDS_ON database_model:Order -> database_model:Customer');
    expect(e).toContain(`IMPORTS ${c('web/OrderController.kt')} -> ${c('order/OrderService.kt')}`);
    expect(e).toContain(`IMPORTS ${c('order/OrderService.kt')} -> ${c('payment/PaymentGateway.kt')}`);
  });
});

describe('Swift', () => {
  const shop = 'Sources/Shop';
  const files = {
    [`${shop}/Order.swift`]: `import Foundation\nimport SwiftData\n\n@Model\nfinal class Order {\n    var id: UUID\n    var total: Double\n\n    init(id: UUID, total: Double) {\n        self.id = id\n        self.total = total\n    }\n}\n`,
    [`${shop}/OrderRepository.swift`]: `import Foundation\n\nfinal class OrderRepository {\n    func find(_ id: String) -> Order? {\n        nil\n    }\n}\n`,
    [`${shop}/OrderService.swift`]: `import Foundation\n\nfinal class OrderService {\n    private let repo: OrderRepository\n    private let stripe: StripeClient\n\n    init(repo: OrderRepository, stripe: StripeClient) {\n        self.repo = repo\n        self.stripe = stripe\n    }\n\n    func checkout(_ id: String) {\n        let order = repo.find(id)\n        stripe.charge(order)\n    }\n}\n`,
    [`${shop}/StripeClient.swift`]: `import Foundation\nimport Stripe\n\nfinal class StripeClient {\n    func charge(_ order: Any?) {\n    }\n}\n`,
    [`${shop}/OrderController.swift`]: `import Vapor\n\nstruct OrderController: RouteCollection {\n    let service: OrderService\n\n    func boot(routes: RoutesBuilder) throws {\n        routes.post("orders", ":id", "checkout", use: self.checkout)\n    }\n\n    func checkout(req: Request) throws {\n        try service.checkout(req.id)\n        service.receipt()\n    }\n}\n`,
    [`${shop}/OrderFormatting.swift`]: `import Foundation\n\nextension OrderService {\n    func receipt() -> String {\n        "receipt"\n    }\n}\n`,
    'Sources/App/main.swift': `import Shop\n\nfunc run() {\n    let service = OrderService(repo: OrderRepository(), stripe: StripeClient())\n    service.checkout("abc")\n}\n`,
  };

  it('resolves modules, injection, Vapor routes, extensions and targets', async () => {
    const e = edges(await build(files));
    expect(e).toContain(`CALLS api_route:POST /orders/:id/checkout -> ${shop}/OrderController.swift#OrderController.checkout`);
    expect(e).toContain(`CALLS ${shop}/OrderController.swift#OrderController.checkout -> ${shop}/OrderService.swift#OrderService.checkout`);
    expect(e).toContain(`CALLS ${shop}/OrderController.swift#OrderController.checkout -> ${shop}/OrderFormatting.swift#OrderService.receipt`);
    expect(e).toContain(`CALLS ${shop}/OrderService.swift#OrderService.checkout -> ${shop}/OrderRepository.swift#OrderRepository.find`);
    expect(e).toContain(`CALLS ${shop}/OrderService.swift#OrderService.checkout -> ${shop}/StripeClient.swift#StripeClient.charge`);
    expect(e).toContain(`USES ${shop}/StripeClient.swift -> external_service:Stripe`);
    expect(e).toContain('CALLS Sources/App/main.swift#run -> Sources/Shop/OrderService.swift#OrderService.checkout');
    expect(e).toContain('CALLS Sources/App/main.swift#run -> Sources/Shop/OrderService.swift#OrderService');
    expect(e).toContain(`IMPORTS Sources/App/main.swift -> ${shop}/OrderService.swift`);
  });
});

describe('C', () => {
  const files = {
    'src/order.h': `#ifndef ORDER_H\n#define ORDER_H\n\ntypedef struct {\n    int id;\n    double total;\n} Order;\n\ntypedef int OrderId;\n\nOrder *order_create(OrderId id);\ndouble order_total(const Order *o);\nvoid order_free(Order *o);\n\n#endif\n`,
    'src/order.c': `#include "order.h"\n#include <stdlib.h>\n\nOrder *order_create(OrderId id) {\n    Order *o = malloc(sizeof(Order));\n    o->id = id;\n    return o;\n}\n\ndouble order_total(const Order *o) {\n    return o->total;\n}\n\nvoid order_free(Order *o) {\n    free(o);\n}\n`,
    'include/util.h': `#ifndef UTIL_H\n#define UTIL_H\n\nint util_version(void);\n\n#endif\n`,
    'src/main.c': `#include <stdio.h>\n#include "order.h"\n#include "util.h"\n\nstatic int handle_checkout(void *conn, void *data) {\n    (void)conn;\n    (void)data;\n    Order *o = order_create(7);\n    printf("%f\\n", order_total(o));\n    order_free(o);\n    return 200;\n}\n\nint main(void) {\n    if (util_version() < 2) return 1;\n    void *ctx = 0;\n    mg_set_request_handler(ctx, "/orders/**", handle_checkout, 0);\n    return 0;\n}\n`,
  };

  it('resolves quoted includes, header prototypes, -I suffixes and CivetWeb routes', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS src/main.c#handle_checkout -> src/order.h#order_create');
    expect(e).toContain('CALLS src/main.c#handle_checkout -> src/order.h#order_total');
    expect(e).toContain('CALLS src/main.c#handle_checkout -> src/order.h#order_free');
    expect(e).toContain('CALLS src/main.c#main -> include/util.h#util_version');
    expect(e).toContain('CALLS api_route:ANY /orders/** -> src/main.c#handle_checkout');
    expect(e).toContain('IMPORTS src/main.c -> src/order.h');
    expect(e).toContain('IMPORTS src/main.c -> include/util.h');
    expect(e).toContain('IMPORTS src/order.c -> src/order.h');
    // Angle includes are system headers: no edges.
    expect(e.filter((x) => x.startsWith('IMPORTS src/main.c'))).toEqual(['IMPORTS src/main.c -> include/util.h', 'IMPORTS src/main.c -> src/order.h']);
  });
});

describe('C++', () => {
  const files = {
    'include/shop/order.hpp': `#pragma once\n\n#include <string>\n\nnamespace shop {\n\nclass Order {\npublic:\n    Order(int id);\n    int total() const;\nprivate:\n    int id_;\n};\n\nOrder *find_order(const std::string &ref);\n\n}\n`,
    'src/order.cpp': `#include "shop/order.hpp"\n\nnamespace shop {\n\nOrder::Order(int id) : id_(id) {\n}\n\nint Order::total() const {\n    return id_;\n}\n\nOrder *find_order(const std::string &ref) {\n    (void)ref;\n    return new Order(1);\n}\n\n}\n`,
    'src/main.cpp': `#include <cstdio>\n#include "shop/order.hpp"\n\nusing namespace shop;\n\nint main() {\n    Order o(1);\n    int t = o.total();\n    Order *found = find_order("x");\n    (void)found;\n    std::printf("%d\\n", t);\n    return 0;\n}\n`,
  };

  it('resolves includes, out-of-class members, construction and using directives', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS src/main.cpp#main -> include/shop/order.hpp#Order');
    expect(e).toContain('CALLS src/main.cpp#main -> include/shop/order.hpp#Order.total');
    expect(e).toContain('CALLS src/main.cpp#main -> include/shop/order.hpp#find_order');
    expect(e).toContain('CALLS src/order.cpp#find_order -> include/shop/order.hpp#Order');
    expect(e).toContain('IMPORTS src/main.cpp -> include/shop/order.hpp');
    expect(e).toContain('IMPORTS src/order.cpp -> include/shop/order.hpp');
    // `using namespace` and angle includes are not file edges.
    expect(e.filter((x) => x.startsWith('IMPORTS src/main.cpp'))).toEqual(['IMPORTS src/main.cpp -> include/shop/order.hpp']);
  });
});

describe('C#', () => {
  const files = {
    'Models/Order.cs': `namespace Shop.Models;\n\npublic class Order { public int Id { get; set; } }\n`,
    'Data/AppDbContext.cs': `using Microsoft.EntityFrameworkCore;\nusing Shop.Models;\n\nnamespace Shop.Data;\n\npublic class AppDbContext : DbContext\n{\n    public DbSet<Order> Orders { get; set; }\n}\n`,
    'Services/IOrderService.cs': `using Shop.Models;\n\nnamespace Shop.Services;\n\npublic interface IOrderService { Task<Order> CheckoutAsync(int id); }\n`,
    'Services/OrderService.cs': `using System;\nusing Shop.Data;\nusing Shop.Models;\nusing Stripe;\n\nnamespace Shop.Services;\n\npublic class OrderService : IOrderService\n{\n    private readonly AppDbContext _db;\n    public OrderService(AppDbContext db) { _db = db; }\n\n    public async Task<Order> CheckoutAsync(int id)\n    {\n        var order = await _db.Orders.FindAsync(id);\n        _db.Orders.Add(order);\n        var items = new List<int>();\n        await new ChargeService().CreateAsync(null);\n        return order;\n    }\n}\n`,
    'Controllers/OrdersController.cs': `using Microsoft.AspNetCore.Mvc;\nusing Shop.Services;\n\nnamespace Shop.Controllers;\n\n[ApiController]\n[Route("api/[controller]")]\npublic class OrdersController : ControllerBase\n{\n    private readonly IOrderService _orders;\n    public OrdersController(IOrderService orders) { _orders = orders; }\n\n    [HttpPost("{id}/checkout")]\n    public Task<Order> Checkout(int id) => _orders.CheckoutAsync(id);\n}\n`,
  };

  it('resolves namespaces, DI fields, ASP.NET routes and EF Core DbSets', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS api_route:POST /api/orders/:id/checkout -> Controllers/OrdersController.cs#OrdersController.Checkout');
    expect(e).toContain('CALLS Controllers/OrdersController.cs#OrdersController.Checkout -> Services/IOrderService.cs#IOrderService.CheckoutAsync');
    expect(e).toContain('IMPLEMENTS Services/OrderService.cs#OrderService -> Services/IOrderService.cs#IOrderService');
    expect(e).toContain('READS_FROM Services/OrderService.cs#OrderService.CheckoutAsync -> database_model:Order');
    expect(e).toContain('WRITES_TO Services/OrderService.cs#OrderService.CheckoutAsync -> database_model:Order');
    expect(e).toContain('USES Services/OrderService.cs -> external_service:Stripe');
    // `using Stripe;` must not claim every unknown name.
    expect(e.filter((x) => x.startsWith('USES Services/OrderService.cs#') && x.endsWith('external_service:Stripe'))).toEqual([]);
    expect(e).toContain('IMPORTS Controllers/OrdersController.cs -> Services/IOrderService.cs');
    expect(e).toContain('IMPORTS Services/OrderService.cs -> Data/AppDbContext.cs');
  });
});

describe('PHP', () => {
  const files = {
    'app/Models/Order.php': `<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Order extends Model\n{\n    public function customer() { return $this->belongsTo(Customer::class); }\n}\n`,
    'app/Models/Customer.php': `<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Customer extends Model {}\n`,
    'app/Services/OrderService.php': `<?php\nnamespace App\\Services;\n\nuse App\\Models\\Order;\nuse Stripe\\StripeClient;\n\nclass OrderService\n{\n    public function __construct(private StripeClient $stripe) {}\n\n    public function checkout(int $id): Order\n    {\n        $order = Order::findOrFail($id);\n        $this->stripe->charges->create([]);\n        $copy = new Order();\n        $copy->save();\n        return $order;\n    }\n}\n`,
    'app/Http/Controllers/OrderController.php': `<?php\nnamespace App\\Http\\Controllers;\n\nuse App\\Services\\OrderService;\n\nclass OrderController extends Controller\n{\n    public function __construct(private OrderService $orders) {}\n\n    public function checkout(int $id) { return $this->orders->checkout($id); }\n}\n`,
    'routes/api.php': `<?php\nuse App\\Http\\Controllers\\OrderController;\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::post('/orders/{id}/checkout', [OrderController::class, 'checkout']);\n`,
  };

  it('resolves namespaces, promoted properties, Laravel routes and Eloquent models', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS api_route:POST /api/orders/:id/checkout -> app/Http/Controllers/OrderController.php#OrderController.checkout');
    expect(e).toContain('CALLS app/Http/Controllers/OrderController.php#OrderController.checkout -> app/Services/OrderService.php#OrderService.checkout');
    expect(e).toContain('READS_FROM app/Services/OrderService.php#OrderService.checkout -> database_model:Order');
    expect(e).toContain('WRITES_TO app/Services/OrderService.php#OrderService.checkout -> database_model:Order');
    expect(e).toContain('USES app/Services/OrderService.php#OrderService.checkout -> external_service:Stripe');
    expect(e).toContain('DEPENDS_ON database_model:Order -> database_model:Customer');
    expect(e).toContain('IMPORTS routes/api.php -> app/Http/Controllers/OrderController.php');
  });
});

describe('Ruby', () => {
  const files = {
    'app/models/order.rb': `class Order < ApplicationRecord\n  belongs_to :customer\nend\n`,
    'app/models/customer.rb': `class Customer < ApplicationRecord\n  has_many :orders\nend\n`,
    'app/services/payment_gateway.rb': `require "stripe"\n\nclass PaymentGateway\n  def charge(order)\n    Stripe::Charge.create(amount: 100)\n  end\nend\n`,
    'app/services/checkout_service.rb': `# Charges and confirms an order.\nclass CheckoutService\n  def initialize(gateway = PaymentGateway.new)\n    @gateway = gateway\n  end\n\n  def call(id)\n    order = Order.find(id)\n    @gateway.charge(order)\n    order\n  end\nend\n`,
    'app/controllers/orders_controller.rb': `class OrdersController < ApplicationController\n  def checkout\n    CheckoutService.new.call(params[:id])\n  end\nend\n`,
    'config/routes.rb': `Rails.application.routes.draw do\n  post "/orders/:id/checkout", to: "orders#checkout"\n  resources :customers, only: [:index, :show]\nend\n`,
  };

  it('resolves autoloaded constants, instance variables, Rails routes and ActiveRecord', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS api_route:POST /orders/:id/checkout -> app/controllers/orders_controller.rb#OrdersController.checkout');
    expect(e).toContain('CALLS app/controllers/orders_controller.rb#OrdersController.checkout -> app/services/checkout_service.rb#CheckoutService.call');
    expect(e).toContain('CALLS app/services/checkout_service.rb#CheckoutService.call -> app/services/payment_gateway.rb#PaymentGateway.charge');
    expect(e).toContain('READS_FROM app/services/checkout_service.rb#CheckoutService.call -> database_model:Order');
    expect(e).toContain('USES app/services/payment_gateway.rb#PaymentGateway.charge -> external_service:Stripe');
    expect(e).toContain('DEPENDS_ON database_model:Order -> database_model:Customer');
    expect(e).toContain('DEPENDS_ON database_model:Customer -> database_model:Order');
    const routes = [...(await build(files)).store.nodes()].filter((n) => n.kind === 'api_route').map((n) => n.name).sort();
    expect(routes).toEqual(['GET /customers', 'GET /customers/:id', 'POST /orders/:id/checkout']);
  });
});

describe('Rust', () => {
  const files = {
    'src/main.rs': `mod db;\nmod routes;\nmod services;\n\nuse axum::{routing::post, Router};\n\nfn app() -> Router {\n    Router::new().route("/orders/:id/checkout", post(routes::checkout))\n}\n`,
    'src/routes.rs': `use crate::services::orders::OrderService;\n\npub async fn checkout() {\n    let svc = OrderService::new();\n    svc.checkout(1).await;\n}\n`,
    'src/services/mod.rs': `pub mod orders;\n`,
    'src/services/orders.rs': `use crate::db::Repo;\nuse async_openai::Client;\n\n/// Checks out orders.\npub struct OrderService {\n    repo: Repo,\n}\n\nimpl OrderService {\n    pub fn new() -> Self {\n        Self { repo: Repo::new() }\n    }\n\n    pub async fn checkout(&self, id: u64) {\n        self.repo.find(id);\n        let ai = Client::new();\n        ai.chat();\n    }\n}\n`,
    'src/db.rs': `pub struct Repo;\n\nimpl Repo {\n    pub fn new() -> Self { Repo }\n    pub fn find(&self, id: u64) {}\n}\n`,
  };

  it('resolves mod files, use trees, impl methods, axum routes and crates', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS api_route:POST /orders/:id/checkout -> src/routes.rs#checkout');
    expect(e).toContain('CALLS src/routes.rs#checkout -> src/services/orders.rs#OrderService.checkout');
    expect(e).toContain('CALLS src/services/orders.rs#OrderService.checkout -> src/db.rs#Repo.find');
    expect(e).toContain('USES src/services/orders.rs#OrderService.checkout -> external_service:OpenAI');
    expect(e).toContain('IMPORTS src/main.rs -> src/routes.rs');
    expect(e).toContain('IMPORTS src/services/mod.rs -> src/services/orders.rs');
    expect(e).toContain('IMPORTS src/routes.rs -> src/services/orders.rs');
  });
});

describe('incremental updates across languages', () => {
  it('refreshes Go callers when receiver methods are added or removed in another package file', async () => {
    const config = { ...emptyProjectConfig(), goModules: [{ dir: '', path: 'example' }] };
    const files = {
      'svc/type.go': `package svc\ntype Service struct {}\nfunc NewService() *Service { return &Service{} }\n`,
      'svc/method.go': `package svc\n`,
      'api/main.go': `package api\nimport "example/svc"\nfunc Run() { s := svc.NewService(); s.Work() }\n`,
    };
    const index = await build(files, config);
    const { SourceParser } = await import('@eyrie/parser');
    const parser = new SourceParser();
    try {
      const method = `package svc\nfunc (s *Service) Work() {}\n`;
      const change = index.update([{ path: 'svc/method.go', facts: await parser.parse('svc/method.go', method) }]);
      expect(change.reresolved).toContain('api/main.go');
      expect(edges(index)).toEqual(edges(await build({ ...files, 'svc/method.go': method }, config)));
      expect(edges(index)).toContain('CALLS api/main.go#Run -> svc/method.go#Service.Work');
      index.update([{ path: 'svc/method.go', facts: null }]);
      const { ['svc/method.go']: _removed, ...remaining } = files;
      expect(edges(index)).toEqual(edges(await build(remaining, config)));
      index.update([{ path: 'svc/method.go', facts: await parser.parse('svc/method.go', method) }]);
      expect(edges(index)).toContain('CALLS api/main.go#Run -> svc/method.go#Service.Work');
      index.update([{ path: 'svc/method.go', facts: await parser.parse('svc/method.go', files['svc/method.go']) }]);
      expect(edges(index)).toEqual(edges(await build(files, config)));
    } finally { parser.dispose(); }
  });

  it('composes imported FastAPI router mounts and updates prefixes without a full reindex', async () => {
    const main = (prefix: string) => `from fastapi import FastAPI\nfrom app.routes import router as orders\napp = FastAPI()\napp.include_router(orders, prefix="${prefix}")\n`;
    const files = {
      'app/main.py': main('/v1'),
      'app/routes.py': `from fastapi import APIRouter\nrouter = APIRouter(prefix="/orders")\n@router.get("/{id}")\ndef detail(id: int): return id\n`,
    };
    const index = await build(files);
    const routeNames = () => [...index.store.nodes()].filter((n) => n.kind === 'api_route').map((n) => n.name).sort();
    expect(routeNames()).toEqual(['GET /v1/orders/:id']);
    expect(edges(index)).toContain('CALLS api_route:GET /v1/orders/:id -> app/routes.py#detail');
    const { SourceParser } = await import('@eyrie/parser');
    const parser = new SourceParser();
    try {
      index.update([{ path: 'app/main.py', facts: await parser.parse('app/main.py', main('/v2')) }]);
      expect(routeNames()).toEqual(['GET /v2/orders/:id']);
      expect(edges(index)).toEqual(edges(await build({ ...files, 'app/main.py': main('/v2') })));
      index.update([{ path: 'app/main.py', facts: null }]);
      expect(routeNames()).toEqual(['GET /orders/:id']);
    } finally { parser.dispose(); }
  });

  it('supports nested and multiple mounts of the same Python router', async () => {
    const index = await build({
      'app/main.py': `from fastapi import FastAPI\nfrom app.api import api\napp = FastAPI()\napp.include_router(api, prefix="/v1")\napp.include_router(api, prefix="/v2")\n`,
      'app/api.py': `from fastapi import APIRouter\nfrom app.routes import router\napi = APIRouter(prefix="/api")\napi.include_router(router=router, prefix="/shop")\n`,
      'app/routes.py': `from fastapi import APIRouter\nrouter = APIRouter(prefix="/orders")\n@router.get("/{id}")\ndef detail(id: int): return id\n`,
    });
    expect([...index.store.nodes()].filter((n) => n.kind === 'api_route').map((n) => n.name).sort()).toEqual(['GET /v1/api/shop/orders/:id', 'GET /v2/api/shop/orders/:id']);
  });

  it('links a Go call once the callee appears in another file of the package', async () => {
    const index = await build({ 'svc/a.go': `package svc\n\nfunc Run() { helper() }\n` });
    expect(edges(index)).not.toContain('CALLS svc/a.go#Run -> svc/b.go#helper');
    const { SourceParser } = await import('@eyrie/parser');
    const parser = new SourceParser();
    index.update([{ path: 'svc/b.go', facts: await parser.parse('svc/b.go', `package svc\n\nfunc helper() {}\n`) }]);
    expect(edges(index)).toContain('CALLS svc/a.go#Run -> svc/b.go#helper');
  });
});

describe('Dart', () => {
  it('resolves package: and relative imports, constructor calls and prefixed members', async () => {
    const e = edges(
      await build({
        'lib/item.dart': `class Item {\n  final String id;\n  Item(this.id);\n}\n`,
        'lib/order.dart': `import 'package:shop/item.dart' show Item;\nimport 'src/format.dart' as fmt;\n\nclass Order {\n  final Item item;\n  Order(this.item);\n  String label() => fmt.describe(item);\n}\n`,
        'lib/src/format.dart': `import '../item.dart';\n\nString describe(Object o) => o.toString();\n`,
        'lib/main.dart': `import 'dart:async';\nimport 'package:other/remote.dart';\nimport 'package:shop/order.dart';\n\nFuture<void> main() async {\n  final o = Order(Item('1'));\n  print(o.label());\n}\n`,
      }),
    );
    expect(e).toContain('CALLS lib/main.dart#main -> lib/order.dart#Order');
    expect(e).toContain('CALLS lib/main.dart#main -> lib/item.dart#Item');
    expect(e).toContain('CALLS lib/main.dart#main -> lib/order.dart#Order.label');
    expect(e).toContain('CALLS lib/order.dart#Order.label -> lib/src/format.dart#describe');
    expect(e).toContain('USES lib/order.dart#Order.label -> lib/item.dart#Item');
    expect(e).toContain('IMPORTS lib/main.dart -> lib/order.dart');
    expect(e).toContain('IMPORTS lib/order.dart -> lib/item.dart');
    expect(e).toContain('IMPORTS lib/order.dart -> lib/src/format.dart');
    expect(e).toContain('IMPORTS lib/src/format.dart -> lib/item.dart');
    // SDK and cross-package imports are external: they leave no edges.
    expect(e.filter((x) => x.includes('remote') || x.includes('async') || x.includes('external_service'))).toEqual([]);
  });
});

describe('Lua', () => {
  it('resolves dotted requires, module members, colon self calls and init.lua', async () => {
    const e = edges(
      await build({
        'main.lua': `local orders = require("shop.orders")\nlocal util = require("shop.util")\nlocal socket = require("socket")\n\nlocal function run(id)\n  return orders.checkout(id) .. util.suffix()\nend\n\nrun("42")\n`,
        'shop/orders.lua': `local M = {}\n\nfunction M.checkout(id)\n  return "order-" .. id\nend\n\nfunction M:summary()\n  return self:checkout("x")\nend\n\nreturn M\n`,
        'shop/util/init.lua': `local M = {}\n\nfunction M.suffix()\n  return "!"\nend\n\nreturn M\n`,
      }),
    );
    expect(e).toContain('CALLS main.lua#run -> shop/orders.lua#M.checkout');
    expect(e).toContain('CALLS main.lua#run -> shop/util/init.lua#M.suffix');
    expect(e).toContain('CALLS shop/orders.lua#M.summary -> shop/orders.lua#M.checkout');
    expect(e).toContain('CALLS main.lua -> main.lua#run');
    expect(e).toContain('IMPORTS main.lua -> shop/orders.lua');
    expect(e).toContain('IMPORTS main.lua -> shop/util/init.lua');
    // Bare rocks (socket) are external: they leave no edges.
    expect(e.filter((x) => x.startsWith('IMPORTS main.lua'))).toEqual(['IMPORTS main.lua -> shop/orders.lua', 'IMPORTS main.lua -> shop/util/init.lua']);
    expect(e.filter((x) => x.includes('socket') || x.includes('external_service'))).toEqual([]);
  });
});

describe('Objective-C', () => {
  // `.h` headers stay mapped to C++, so fixtures keep interfaces in self-contained `.m` files.
  const files = {
    'src/Calc.m': `#import <Foundation/Foundation.h>\n\n@interface Calc : NSObject\n@property int count;\n- (int)add:(int)a with:(int)b;\n+ (instancetype)shared;\n@end\n\n@implementation Calc\n- (int)add:(int)a with:(int)b {\n    return a + b;\n}\n+ (instancetype)shared {\n    return [[Calc alloc] init];\n}\n@end\n`,
    'lib/Helper.m': `int helper_add(int a, int b) {\n    return a + b;\n}\n`,
    'src/main.m': `#import <Foundation/Foundation.h>\n#import "Calc.m"\n#import "Helper.m"\n\nint main(void) {\n    Calc *c = [[Calc alloc] init];\n    int y = [c add:1 with:2];\n    [Calc shared];\n    int z = helper_add(y, 1);\n    return z;\n}\n`,
  };

  it('resolves message sends, quoted imports and -I suffixes', async () => {
    const e = edges(await build(files));
    expect(e).toContain('CALLS src/main.m#main -> src/Calc.m#Calc.add:with:');
    expect(e).toContain('CALLS src/main.m#main -> src/Calc.m#Calc.shared');
    expect(e).toContain('CALLS src/main.m#main -> lib/Helper.m#helper_add');
    expect(e).toContain('IMPORTS src/main.m -> src/Calc.m');
    expect(e).toContain('IMPORTS src/main.m -> lib/Helper.m');
    // Angle imports are frameworks: they leave no edges.
    expect(e.filter((x) => x.startsWith('IMPORTS src/main.m'))).toEqual(['IMPORTS src/main.m -> lib/Helper.m', 'IMPORTS src/main.m -> src/Calc.m']);
  });
});

describe('Vue', () => {
  const files = {
    'src/App.vue': `<template>\n  <main>\n    <UserCard :user="user" />\n    <order-list :items="items" />\n  </main>\n</template>\n\n<script setup lang="ts">\nimport UserCard from './UserCard.vue';\nimport OrderList from './OrderList';\n</script>\n`,
    'src/UserCard.vue': `<template>\n  <div>{{ user.name }}</div>\n</template>\n\n<script>\nexport default {\n  props: ['user'],\n};\n</script>\n`,
    'src/OrderList.vue': `<template>\n  <ul>\n    <li v-for="item in items" :key="item.id">{{ item.name }}</li>\n  </ul>\n</template>\n\n<script setup>\nconst props = defineProps(['items']);\n</script>\n`,
  };

  it('resolves SFC imports (extensionless too) and PascalCase plus kebab-case usage like TSX', async () => {
    const index = await build(files);
    const e = edges(index);
    expect(e).toContain('IMPORTS src/App.vue -> src/UserCard.vue');
    expect(e).toContain('IMPORTS src/App.vue -> src/OrderList.vue');
    // Options-API children expose a default export; script-setup children resolve to the file.
    expect(e).toContain('USES src/App.vue -> src/UserCard.vue#default');
    expect(e).toContain('USES src/App.vue -> src/OrderList.vue');
    // Like TSX jsx refs, component usage carries via:'render'.
    const uses = [...index.store.edges()].filter((x) => x.kind === 'USES' && x.owner === 'src/App.vue');
    expect(uses).toHaveLength(2);
    expect(uses.every((x) => x.meta?.via === 'render')).toBe(true);
  });
});
