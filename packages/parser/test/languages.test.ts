import { describe, expect, it } from 'vitest';
import type { FileFacts } from '@eyrie/core';
import { SourceParser, detectLanguage, goPackageName } from '../src/index.js';

const parser = new SourceParser();
const parse = async (path: string, src: string) => (await parser.parse(path, src))!;
const imports = (f: FileFacts) => f.imports.map((i) => `${i.source}${i.wildcard ? ' *' : ''}${i.typeOnly ? ' type' : ''} {${i.specifiers.map((s) => `${s.imported}>${s.local}`).join(',')}}`);
const routes = (f: FileFacts) => f.routes.map((r) => `${r.method} ${r.path} -> ${r.handlers.join(',')}`);
const refs = (f: FileFacts, from: string) => f.references.filter((r) => r.from === from).map((r) => `${r.kind}:${r.callee.join('.')}`);

describe('language detection', () => {
  it('maps extensions and skips generated code', () => {
    expect(['a.py', 'a.go', 'A.java', 'a.rs', 'A.cs', 'a.php', 'a.rb', 'Rakefile.rake'].map(detectLanguage)).toEqual(['python', 'go', 'java', 'rust', 'csharp', 'php', 'ruby', 'ruby']);
    expect(['A.kt', 'build.kts', 'A.swift', 'a.c', 'a.h', 'a.cpp', 'a.cc', 'a.hpp'].map(detectLanguage)).toEqual(['kotlin', 'kotlin', 'swift', 'c', 'cpp', 'cpp', 'cpp', 'cpp']);
    expect(['a.dart', 'A.vue', 'a.m', 'a.lua'].map(detectLanguage)).toEqual(['dart', 'vue', 'objc', 'lua']);
    expect(['api.pb.go', 'msg_pb2.py', 'Form1.Designer.cs', 'types.d.ts', 'msg.pb.cc', 'moc_widget.cpp', 'ui_main.h', 'user.g.dart', 'user.freezed.dart'].map(detectLanguage)).toEqual([null, null, null, null, null, null, null, null, null]);
  });
});

describe('Python adapter', () => {
  it('records imports, typed locals, self fields and docstrings', async () => {
    const f = await parse(
      'app/svc.py',
      `from __future__ import annotations\nimport os.path\nimport numpy as np\nfrom . import models\nfrom ..repo import Repo as R, other\nfrom x import *\nfrom typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from app.types import Order\n\nclass Svc(Base):\n    """Runs things.\n\n    More detail.\n    """\n    repo: R\n    def __init__(self, ai: AI):\n        self.ai = ai\n        self.cache = Cache()\n\n    async def run(self, n: int):\n        helper = Helper()\n        helper.go()\n        self.repo.save(n)\n        super().run()\n`,
    );
    expect(imports(f)).toEqual([
      '__future__ {annotations>annotations}',
      'os.path {*>os}',
      'numpy {*>np}',
      '. {models>models}',
      '..repo {Repo>R,other>other}',
      'x * {}',
      'typing {TYPE_CHECKING>TYPE_CHECKING}',
      'app.types type {Order>Order}',
    ]);
    const svc = f.symbols.find((s) => s.name === 'Svc')!;
    expect(svc).toMatchObject({ kind: 'class', exported: true, extends: ['Base'], doc: 'Runs things.' });
    expect(svc.fields).toEqual([{ name: 'repo', type: 'R' }, { name: 'ai', type: 'AI' }, { name: 'cache', instanceOf: 'Cache' }]);
    expect(f.symbols.find((s) => s.qualifiedName === 'Svc.run')).toMatchObject({ kind: 'method', async: true, locals: { n: 'int', helper: 'Helper' } });
    expect(refs(f, 'Svc.run')).toEqual(['new:Helper', 'call:helper.go', 'call:this.repo.save', 'ref:n', 'call:super().run']);
  });

  it('records Django urlpatterns and Django / SQLAlchemy models', async () => {
    const urls = await parse('shop/urls.py', `from django.urls import path, include\nfrom . import views\n\nurlpatterns = [\n    path("orders/<int:pk>/", views.OrderDetail.as_view()),\n    path("api/", include("shop.api")),\n]\n`);
    expect(routes(urls)).toEqual(['ANY /orders/:pk -> views.OrderDetail']);
    const models = await parse(
      'shop/models.py',
      `from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship\n\nclass Base(DeclarativeBase):\n    pass\n\nclass Order(Base):\n    __tablename__ = "orders"\n    id: Mapped[int] = mapped_column(primary_key=True)\n    items: Mapped[list["Item"]] = relationship(back_populates="order")\n\nclass Plain(Base):\n    pass\n`,
    );
    expect(models.models?.map((m) => `${m.name}:${m.orm}:${m.relations}`)).toEqual(['Order:sqlalchemy:Item']);
  });
});

describe('Go adapter', () => {
  it('derives package names from import paths', () => {
    expect(['github.com/go-chi/chi/v5', 'github.com/sashabaranov/go-openai', 'gopkg.in/yaml.v3', 'net/http'].map(goPackageName)).toEqual(['chi', 'openai', 'yaml', 'http']);
  });

  it('records dot and blank imports, gorilla routes and constructor locals', async () => {
    const f = await parse(
      'cmd/main.go',
      `package main\n\nimport (\n\t. "github.com/acme/util"\n\t_ "github.com/lib/pq"\n\tsvc "github.com/acme/shop/order"\n)\n\nfunc main() {\n\ts := svc.NewService(nil)\n\tr := mux.NewRouter()\n\tr.HandleFunc("/orders/{id}", s.Get).Methods("PUT")\n\te.GET("/items", listItems)\n}\n`,
    );
    expect(imports(f)).toEqual(['github.com/acme/util * {}', 'github.com/lib/pq {}', 'github.com/acme/shop/order {*>svc}']);
    expect(routes(f)).toEqual(['PUT /orders/:id -> s.Get', 'GET /items -> listItems']);
    expect(f.symbols.find((s) => s.name === 'main')?.locals).toMatchObject({ s: 'svc.Service' });
  });
});

describe('Java adapter', () => {
  it('records static imports, JAX-RS routes and entity relations', async () => {
    const f = await parse(
      'src/a/OrderResource.java',
      `package a;\n\nimport static a.util.Strings.trim;\n\n@Path("/orders")\npublic class OrderResource {\n  @GET\n  @Path("/{id}")\n  public Order get(@PathParam("id") long id) { return trim(id); }\n\n  @POST\n  public void create() {}\n}\n\n@Entity\nclass Order {\n  @OneToMany(mappedBy = "order") private List<Item> items;\n  @ManyToOne private Customer customer;\n}\n`,
    );
    expect(imports(f)).toEqual(['a.util.Strings {Strings.trim>trim}']);
    expect(routes(f)).toEqual(['GET /orders/:id -> OrderResource.get', 'POST /orders -> OrderResource.create']);
    expect(f.models?.map((m) => `${m.name}:${m.relations}`)).toEqual(['Order:Item,Customer']);
  });
});

describe('C# adapter', () => {
  it('records alias usings, controller actions, minimal-API groups and primary constructors', async () => {
    const f = await parse(
      'Api/Program.cs',
      `using Repo = Shop.Data.OrderRepository;\nnamespace Shop.Api\n{\n    [Route("api/[controller]")]\n    public class ItemsController(IItemService items) : ControllerBase\n    {\n        [HttpGet("[action]/{id}")]\n        public Item Find(int id) => items.Find(id);\n    }\n}\n`,
    );
    expect(f.namespace).toBe('Shop.Api');
    expect(imports(f)).toEqual(['Shop.Data.OrderRepository {OrderRepository>Repo}']);
    expect(routes(f)).toEqual(['GET /api/items/find/:id -> ItemsController.Find']);
    expect(f.symbols.find((s) => s.name === 'ItemsController')?.fields).toEqual([{ name: 'items', type: 'IItemService' }]);
    expect(refs(f, 'ItemsController.Find')).toContain('call:this.items.Find');

    const min = await parse('Program.cs', `var app = builder.Build();\nvar api = app.MapGroup("/api");\napi.MapPost("/orders", CreateOrder);\napp.MapGet("/health", () => Results.Ok());\n`);
    expect(routes(min)).toEqual(['POST /api/orders -> CreateOrder', 'GET /health -> ']);
  });
});

describe('PHP adapter', () => {
  it('records grouped uses, includes, Symfony attribute routes', async () => {
    const f = await parse(
      'src/Controller/OrderController.php',
      `<?php\nnamespace App\\Controller;\n\nuse App\\Entity\\{Order, Item as Line};\nrequire_once __DIR__ . '/../helpers.php';\n\n#[Route('/orders')]\nclass OrderController extends AbstractController\n{\n    #[Route('/{id}', methods: ['GET', 'HEAD'])]\n    public function show(int $id): Response { return $this->render('x'); }\n}\n`,
    );
    expect(f.namespace).toBe('App.Controller');
    expect(imports(f)).toEqual(['App.Entity.Order {Order>Order}', 'App.Entity.Item {Item>Line}', './../helpers.php {}']);
    expect(routes(f)).toEqual(['GET /orders/:id -> OrderController.show', 'HEAD /orders/:id -> OrderController.show']);
  });

  it('records Laravel groups, match, resources and fluent prefixes', async () => {
    const f = await parse(
      'routes/api.php',
      `<?php\nRoute::group(['prefix' => 'v1', 'namespace' => 'Api'], function () {\n    Route::match(['put', 'patch'], 'user', 'UserController@update');\n    Route::resource('articles', 'ArticleController', ['except' => ['create', 'edit', 'update']]);\n});\nRoute::prefix('admin')->middleware('auth')->group(function () {\n    Route::get('stats', [StatsController::class, 'index']);\n});\n`,
    );
    expect(routes(f)).toEqual([
      'PUT /api/v1/user -> UserController.update',
      'PATCH /api/v1/user -> UserController.update',
      'GET /api/v1/articles -> ArticleController.index',
      'POST /api/v1/articles -> ArticleController.store',
      'GET /api/v1/articles/:article -> ArticleController.show',
      'DELETE /api/v1/articles/:article -> ArticleController.destroy',
      'GET /api/admin/stats -> StatsController.index',
    ]);
  });
});

describe('Ruby adapter', () => {
  it('records namespaced and nested Rails routes and Sinatra blocks', async () => {
    const f = await parse(
      'config/routes.rb',
      `Rails.application.routes.draw do\n  root "home#index"\n  namespace :api do\n    resources :orders, only: [:show] do\n      resources :items, only: [:index]\n    end\n    patch "/orders/:id/pay" => "payments#create"\n  end\nend\n`,
    );
    expect(routes(f)).toEqual([
      'GET / -> HomeController.index',
      'GET /api/orders/:id -> OrdersController.show',
      'GET /api/orders/:order_id/items -> ItemsController.index',
      'PATCH /api/orders/:id/pay -> PaymentsController.create',
    ]);
    const app = await parse('app.rb', `require "sinatra"\n\nget "/hi/:name" do\n  Greeter.new.greet(params[:name])\nend\n`);
    expect(routes(app)).toEqual(['GET /hi/:name -> ']);
    expect(refs(app, 'route:GET /hi/:name')).toEqual(['call:Greeter.greet', 'new:Greeter']);
  });

  it('records attr readers, mixins and the enclosing module as namespace', async () => {
    const f = await parse('lib/billing/charge.rb', `module Billing\n  class Charge < Base\n    include Auditable\n    attr_reader :gateway\n\n    def run\n      gateway.call\n    end\n  end\nend\n`);
    expect(f.namespace).toBe('Billing');
    expect(f.symbols.find((s) => s.name === 'Charge')).toMatchObject({ extends: ['Base', 'Auditable'], fields: [{ name: 'gateway' }] });
    expect(refs(f, 'Charge.run')).toEqual(['call:this.gateway.call']);
  });
});

describe('Kotlin adapter', () => {
  it('records aliased imports, constructor fields, Spring routes and suspend', async () => {
    const f = await parse(
      'src/shop/api/OrderController.kt',
      `package shop.api\n\nimport shop.order.OrderService\nimport shop.order.Order as O\nimport shop.util.*\n\n@RestController\n@RequestMapping("/api")\nclass OrderController(private val service: OrderService) {\n    companion object {\n        const val TAG = "orders"\n    }\n\n    @GetMapping("/orders/{id}")\n    suspend fun get(@PathVariable id: String): O {\n        return service.find(id)\n    }\n\n    val lazyRepo by lazy { Repo() }\n}\n\nfun main() {\n    println("up")\n}\n`,
    );
    expect(f.namespace).toBe('shop.api');
    expect(imports(f)).toEqual(['shop.order.OrderService {OrderService>OrderService}', 'shop.order.Order {Order>O}', 'shop.util * {}']);
    expect(routes(f)).toEqual(['GET /api/orders/:id -> OrderController.get']);
    expect(f.symbols.find((s) => s.name === 'OrderController')?.fields).toEqual([{ name: 'service', type: 'OrderService' }, { name: 'TAG' }, { name: 'lazyRepo' }]);
    expect(f.symbols.find((s) => s.qualifiedName === 'OrderController.get')).toMatchObject({ kind: 'method', async: true, locals: { id: 'String' } });
    expect(refs(f, 'OrderController.get')).toEqual(['call:this.service.find', 'ref:id']);
    expect(refs(f, 'OrderController')).toEqual(['call:lazy', 'new:Repo']);
    expect(f.symbols.find((s) => s.name === 'main')).toMatchObject({ kind: 'function' });
    expect(f.parseErrors).toBe(0);
  });

  it('records Ktor routes, extension functions and Exposed tables', async () => {
    const f = await parse(
      'src/shop/Routes.kt',
      `package shop\n\nimport io.ktor.server.application.*\nimport io.ktor.server.routing.*\n\nfun Application.module() {\n    routing {\n        route("/api") {\n            get("/orders/{id}") {\n                call.respond(findOrder())\n            }\n        }\n    }\n}\n\nfun Route.health() {\n    get("/health") {\n        call.respond("ok")\n    }\n}\n\nobject Orders : Table("orders") {\n    val id = long("id")\n    val customer = reference("customer", Customers)\n}\n`,
    );
    expect(routes(f)).toEqual(['GET /api/orders/:id -> ', 'GET /health -> ']);
    expect(refs(f, 'route:GET /api/orders/:id')).toEqual(['call:call.respond', 'call:findOrder']);
    expect(refs(f, 'route:GET /health')).toEqual(['call:call.respond']);
    expect(f.symbols.find((s) => s.qualifiedName === 'Route.health')).toMatchObject({ kind: 'method' });
    expect(f.models?.map((m) => `${m.name}:${m.orm}:${m.relations}`)).toEqual(['Orders:exposed:Customers']);
  });

  it('records JPA entities on data classes', async () => {
    const f = await parse(
      'src/shop/order/Order.kt',
      `package shop.order\n\nimport jakarta.persistence.*\n\n@Entity\n@Table(name = "orders")\ndata class Order(\n    @Id val id: Long,\n    @ManyToOne val customer: Customer,\n) {\n    fun total(): Double = 0.0\n}\n\nenum class Status {\n    OPEN, PAID\n}\n`,
    );
    expect(f.models?.map((m) => `${m.name}:${m.orm}:${m.relations}`)).toEqual(['Order:jpa:Customer']);
    expect(f.models?.[0]?.fields).toEqual(['id', 'customer']);
    expect(f.symbols.find((s) => s.name === 'Order')).toMatchObject({ kind: 'class', fields: [{ name: 'id', type: 'Long' }, { name: 'customer', type: 'Customer' }] });
    expect(f.symbols.find((s) => s.name === 'Status')).toMatchObject({ kind: 'enum' });
    expect(f.parseErrors).toBe(0);
  });

  it('recovers classes the grammar swallows behind stacked annotations', async () => {
    const cases: [string, string, string][] = [
      ['class A {\n}\n', 'A', 'class'],
      ['interface I {\n}\n', 'I', 'interface'],
      ['enum class E {\n    X\n}\n', 'E', 'enum'],
      ['open class C {\n    fun f(): Int = 1\n}\n', 'C', 'class'],
      ['sealed interface S {\n    fun f(): Int\n}\n', 'S', 'interface'],
    ];
    for (const [decl, name, kind] of cases) {
      const f = await parse('A.kt', `@A\n@B\n${decl}\nfun tail() {}\n`);
      expect(f.symbols.find((s) => s.name === name)).toMatchObject({ kind, startLine: 3 });
      expect(f.parseErrors).toBe(0);
    }
    const f = await parse('C.kt', `@A\n@B\nopen class C {\n    fun f(): Int = 1\n}\n\nfun tail() {}\n`);
    expect(f.symbols.find((s) => s.qualifiedName === 'C.f')).toMatchObject({ kind: 'method', startLine: 4 });
  });
});

describe('Swift adapter', () => {
  it('records inits, fields, extensions and Self construction', async () => {
    const f = await parse(
      'Sources/Shop/OrderService.swift',
      `import Foundation\n\n/// An order service.\nfinal class OrderService {\n    private let repo: OrderRepository\n    var count = 0\n    let gateway = PaymentGateway()\n\n    init(repo: OrderRepository) {\n        self.repo = repo\n    }\n\n    static func make() -> Self {\n        Self()\n    }\n\n    func checkout(_ id: String) async throws -> Order {\n        let order = try await repo.find(id)\n        if let o = order {\n            return o\n        }\n        throw CheckoutError.missing\n    }\n}\n\nextension OrderService {\n    var label: String {\n        "service"\n    }\n}\n`,
    );
    expect(imports(f)).toEqual(['Foundation {}']);
    expect(f.symbols.find((s) => s.name === 'OrderService')).toMatchObject({
      kind: 'class',
      doc: 'An order service.',
      fields: [{ name: 'repo', type: 'OrderRepository' }, { name: 'count' }, { name: 'gateway', instanceOf: 'PaymentGateway' }],
    });
    expect(f.symbols.find((s) => s.qualifiedName === 'OrderService.init')).toMatchObject({ kind: 'method', locals: { repo: 'OrderRepository' } });
    expect(f.symbols.find((s) => s.qualifiedName === 'OrderService.checkout')).toMatchObject({ kind: 'method', async: true, locals: { id: 'String' } });
    expect(refs(f, 'OrderService.checkout')).toEqual(['call:this.repo.find', 'ref:id']);
    expect(refs(f, 'OrderService.make')).toEqual(['new:OrderService']);
    expect(refs(f, 'OrderService')).toEqual(['new:PaymentGateway']);
    expect(f.symbols.find((s) => s.qualifiedName === 'OrderService.label')).toMatchObject({ kind: 'variable' });
    expect(f.parseErrors).toBe(0);
  });

  it('records Vapor routes, grouped prefixes and path components', async () => {
    const f = await parse(
      'Sources/Shop/OrderController.swift',
      `import Vapor\n\nstruct OrderController: RouteCollection {\n    func boot(routes: RoutesBuilder) throws {\n        let v1 = routes.grouped("v1")\n        v1.get("orders", ":id", use: self.get)\n        routes.get(.constant("health"), use: self.health)\n    }\n\n    func get(req: Request) async throws -> Order {\n        try await Order.query(on: req.db).first()\n    }\n\n    func health(req: Request) -> String {\n        "ok"\n    }\n}\n`,
    );
    expect(routes(f)).toEqual(['GET /v1/orders/:id -> OrderController.get', 'GET /health -> OrderController.health']);
    expect(refs(f, 'route:GET /v1/orders/:id')).toEqual(['ref:this.get']);
    expect(refs(f, 'route:GET /health')).toEqual(['ref:this.health']);
    expect(f.symbols.find((s) => s.name === 'OrderController')).toMatchObject({ kind: 'class', implements: ['RouteCollection'] });
    expect(refs(f, 'OrderController.get')).toEqual(['call:Order.query().first', 'call:Order.query', 'ref:req.db']);
    expect(f.parseErrors).toBe(0);
  });

  it('records SwiftData models, enums, protocols and extension conformance', async () => {
    const f = await parse(
      'Sources/Shop/Order.swift',
      `import Foundation\nimport SwiftData\n\n@Model\nfinal class Order {\n    @Attribute(.unique) var id: UUID\n    @Relationship(deleteRule: .cascade) var items: [Item]?\n\n    init(id: UUID) {\n        self.id = id\n    }\n}\n\nenum Status: String {\n    case open, paid\n}\n\nprotocol Store {\n    func save(_ order: Order)\n}\n\nextension Order: CustomStringConvertible {\n    var description: String {\n        id.uuidString\n    }\n}\n`,
    );
    expect(f.models?.map((m) => `${m.name}:${m.orm}:${m.relations}`)).toEqual(['Order:swiftdata:Item']);
    expect(f.models?.[0]?.fields).toEqual(['id', 'items']);
    expect(f.symbols.find((s) => s.name === 'Status')).toMatchObject({ kind: 'enum', implements: ['String'] });
    expect(f.symbols.find((s) => s.qualifiedName === 'Store.save')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'Order')).toMatchObject({ implements: ['CustomStringConvertible'] });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.description')).toMatchObject({ kind: 'variable' });
    expect(f.parseErrors).toBe(0);
  });
});

describe('C adapter', () => {
  it('records structs, typedefs, macros and header prototypes', async () => {
    const f = await parse(
      'src/order.h',
      `#ifndef ORDER_H\n#define ORDER_H\n\n#include <stddef.h>\n\n#define MAX_ITEMS 100\n#define DISCOUNTED(price, pct) ((price) * (100 - (pct)) / 100)\n\ntypedef struct {\n    int id;\n    double total;\n} Order;\n\ntypedef int OrderId;\n\ntypedef enum {\n    ORDER_OPEN,\n    ORDER_PAID\n} OrderStatus;\n\nstruct OrderStore;\n\nint order_create(Order *o);\nvoid order_free(Order *o);\n\n#endif\n`,
    );
    expect(imports(f)).toEqual(['<stddef.h> * {}']);
    expect(f.symbols.map((s) => s.name)).toEqual(['MAX_ITEMS', 'DISCOUNTED', 'Order', 'OrderId', 'OrderStatus', 'order_create', 'order_free']);
    expect(f.symbols.find((s) => s.name === 'Order')).toMatchObject({ kind: 'class', fields: [{ name: 'id', type: 'int' }, { name: 'total', type: 'double' }] });
    expect(f.symbols.find((s) => s.name === 'OrderId')).toMatchObject({ kind: 'type', typeName: 'int' });
    expect(f.symbols.find((s) => s.name === 'OrderStatus')).toMatchObject({ kind: 'enum' });
    expect(f.symbols.find((s) => s.name === 'order_create')).toMatchObject({ kind: 'function', locals: { o: 'Order' } });
    expect(f.parseErrors).toBe(0);
  });

  it('records globals, calls and address-taken references', async () => {
    const f = await parse(
      'src/order.c',
      `#include <stdio.h>\n#include <stdlib.h>\n#include "order.h"\n\nstatic int next_id = 1;\nint order_count = 0;\n\nint order_create(Order *o) {\n    if (!o) return -1;\n    o->id = next_id++;\n    o->total = 0;\n    printf("created %d\\n", o->id);\n    return 0;\n}\n\nvoid order_free(Order *o) {\n    free(o);\n}\n\nstatic void helper(void) {\n    order_count = order_create(NULL);\n}\n`,
    );
    expect(imports(f)).toEqual(['<stdio.h> * {}', '<stdlib.h> * {}', 'order.h * {}']);
    expect(f.symbols.find((s) => s.name === 'next_id')).toMatchObject({ kind: 'variable', exported: false });
    expect(f.symbols.find((s) => s.name === 'order_count')).toMatchObject({ kind: 'variable', exported: true });
    expect(f.symbols.find((s) => s.name === 'order_create')).toMatchObject({ kind: 'function', locals: { o: 'Order' } });
    expect(refs(f, 'order_create')).toEqual(['call:printf', 'ref:o.id']);
    expect(refs(f, 'order_free')).toEqual(['call:free', 'ref:o']);
    expect(refs(f, 'helper')).toEqual(['call:order_create']);
    expect(f.parseErrors).toBe(0);
  });

  it('records CivetWeb route registrations', async () => {
    const f = await parse(
      'src/main.c',
      `#include "civetweb.h"\n\nstatic void handle_checkout(struct mg_connection *conn, void *data);\n\nint main(void) {\n    struct mg_context *ctx = mg_start(NULL, NULL, NULL);\n    mg_set_request_handler(ctx, "/api/orders/*", handle_checkout, NULL);\n    return 0;\n}\n`,
    );
    expect(routes(f)).toEqual(['ANY /api/orders/* -> handle_checkout']);
    expect(refs(f, 'main')).toContain('call:mg_start');
    expect(f.parseErrors).toBe(0);
  });
});

describe('C++ adapter', () => {
  it('records classes, operators, nested types and namespaces', async () => {
    const f = await parse(
      'src/order.hpp',
      `#ifndef ORDER_HPP\n#define ORDER_HPP\n\n#include <string>\n#include <vector>\n#include "money.hpp"\n\nnamespace shop {\n\nclass Order {\npublic:\n    Order(int id);\n    ~Order();\n    int total() const;\n    virtual void save() = 0;\n    bool operator==(const Order& other) const;\n\nprivate:\n    int id_;\n    static int count_;\n};\n\nstruct Point {\n    int x, y;\n};\n\nenum class Status {\n    Open,\n    Paid\n};\n\n} // namespace shop\n\n#endif\n`,
    );
    expect(imports(f)).toEqual(['<string> * {}', '<vector> * {}', 'money.hpp * {}']);
    expect(f.namespace).toBe('shop');
    expect(f.symbols.find((s) => s.name === 'Order')).toMatchObject({ kind: 'class', fields: [{ name: 'id_', type: 'int' }, { name: 'count_', type: 'int' }] });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.constructor')).toMatchObject({ kind: 'method', locals: { id: 'int' } });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.destructor')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.total')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.operator==')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'Point')).toMatchObject({ kind: 'class', fields: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }] });
    expect(f.symbols.find((s) => s.name === 'Status')).toMatchObject({ kind: 'enum' });
    expect(f.parseErrors).toBe(0);
  });

  it('records out-of-class definitions, templates, using and modern statements', async () => {
    const f = await parse(
      'src/order.cpp',
      `#include <cstdio>\n#include "order.hpp"\n\nusing namespace shop;\nusing shop::Order;\n\nnamespace shop {\n\nOrder::Order(int id) : id_(id) {\n}\n\nint Order::total() const {\n    return this->id_ + helper(id_);\n}\n\nint Order::count_ = 0;\n\ntemplate <typename T>\nT maxof(T a, T b) {\n    return a > b ? a : b;\n}\n\n}\n\nint main() {\n    auto o = Order(42);\n    auto total = o.total();\n    auto doubled = maxof<int>(total, 1);\n    Order* p = new Order(1);\n    delete p;\n    try {\n        shop::Order q(2);\n    } catch (const std::exception& e) {\n        std::printf("err");\n    }\n    return 0;\n}\n`,
    );
    expect(imports(f)).toEqual(['<cstdio> * {}', 'order.hpp * {}', 'shop * {}', 'shop {Order>Order}']);
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.constructor')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.total')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.count_')).toMatchObject({ kind: 'variable' });
    expect(f.symbols.find((s) => s.name === 'maxof')).toMatchObject({ kind: 'function', locals: { a: 'T', b: 'T' } });
    expect(refs(f, 'Order.total')).toEqual(['call:helper', 'ref:id_']);
    expect(refs(f, 'main')).toEqual(['new:Order', 'call:o.total', 'call:maxof', 'ref:total', 'new:Order', 'new:Order', 'call:printf']);
    expect(f.parseErrors).toBe(0);
  });
});

describe('Rust adapter', () => {
  it('records use trees, trait impls, actix routes and skips test modules', async () => {
    const f = await parse(
      'src/handlers.rs',
      `use super::db::{self, Pool as DbPool};\nuse crate::models::*;\n\npub trait Store { fn save(&self); }\npub struct Pg;\nimpl Store for Pg { fn save(&self) {} }\n\n#[post("/orders")]\nasync fn create(pool: web::Data<DbPool>) -> impl Responder { db::insert(&pool); }\n\n#[cfg(test)]\nmod tests { fn t() { create(); } }\n`,
    );
    expect(imports(f)).toEqual(['super::db {*>db}', 'super::db {Pool>DbPool}', 'crate::models * {}']);
    expect(f.symbols.find((s) => s.name === 'Pg')?.implements).toEqual(['Store']);
    expect(routes(f)).toEqual(['POST /orders -> create']);
    expect(f.symbols.find((s) => s.name === 'create')?.locals).toEqual({ pool: 'DbPool' });
    expect(f.symbols.some((s) => s.name === 't')).toBe(false);
  });

  it('names sea-orm entities after their file', async () => {
    const f = await parse('src/entity/order.rs', `#[derive(Clone, Debug, DeriveEntityModel)]\n#[sea_orm(table_name = "orders")]\npub struct Model { pub id: i32 }\n`);
    expect(f.models?.map((m) => `${m.name}:${m.orm}:${m.symbol}`)).toEqual(['Order:sea-orm:Model']);
  });
});

describe('Dart adapter', () => {
  it('records package imports, combinators, classes, constructors and refs', async () => {
    const f = await parse(
      'lib/order.dart',
      `import 'dart:async';\nimport 'package:shop/item.dart' show Item;\nimport 'package:shop/hidden.dart' show Shown hide Other;\nimport '../util.dart' as u;\nimport 'plain.dart';\n\n/// An order.\nclass Order extends u.Base with Logger implements Comparable {\n  final String name;\n  int total = 0;\n\n  Order(this.name, {this.total = 0});\n  Order.named(this.name) : total = 1;\n  factory Order.fromJson(Map<String, dynamic> json) => Order('x');\n\n  int get count => total;\n  set count(int v) {\n    total = v;\n  }\n\n  static Future<Order> load(String id) async {\n    final item = Item(id);\n    u.helper(item);\n    return Order.named('x');\n  }\n}\n`,
    );
    expect(imports(f)).toEqual([
      'dart:async * {}',
      'package:shop/item.dart {Item>Item}',
      'package:shop/hidden.dart {Shown>Shown}',
      '../util.dart {*>u}',
      'plain.dart * {}',
    ]);
    expect(f.symbols.find((s) => s.name === 'Order')).toMatchObject({
      kind: 'class',
      exported: true,
      extends: ['u.Base', 'Logger'],
      implements: ['Comparable'],
      doc: 'An order.',
      fields: [
        { name: 'name', type: 'String' },
        { name: 'total', type: 'int' },
      ],
    });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.constructor')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.named')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.fromJson')).toMatchObject({ kind: 'method', locals: { json: 'Map' } });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.count')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Order.load')).toMatchObject({ kind: 'method', async: true, locals: { id: 'String', item: 'Item' } });
    expect(refs(f, 'Order.fromJson')).toEqual(['new:Order']);
    expect(refs(f, 'Order.load')).toEqual(['new:Item', 'ref:id', 'call:u.helper', 'ref:item', 'call:Order.named']);
    expect(f.parseErrors).toBe(0);
  });

  it('records enums, mixins, extensions, typedefs, top-level members and widgets plainly', async () => {
    const f = await parse(
      'lib/shop.dart',
      `import 'package:flutter/widgets.dart';\n\nenum Color { red, green }\n\nmixin Logger {\n  void log(String m) {\n    print(m);\n  }\n}\n\nclass Cart {\n  final List<String> items = const [];\n  void add(String item) {\n    log(item);\n  }\n}\n\nextension CartExt on Cart {\n  int get size => items.length;\n  void clear() {\n    items.clear();\n  }\n}\n\ntypedef Handler = void Function(String s);\n\nint _counter = 0;\nint get counter => _counter;\n\nclass MyWidget extends StatefulWidget {\n  @override\n  State<MyWidget> createState() => _MyWidgetState();\n}\n\nclass _MyWidgetState extends State<MyWidget> {\n  @override\n  Widget build(BuildContext context) => Container();\n}\n`,
    );
    expect(imports(f)).toEqual(['package:flutter/widgets.dart * {}']);
    expect(f.symbols.find((s) => s.name === 'Color')).toMatchObject({ kind: 'enum' });
    expect(f.symbols.find((s) => s.name === 'Logger')).toMatchObject({ kind: 'class' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Logger.log')).toMatchObject({ kind: 'method', locals: { m: 'String' } });
    expect(f.symbols.find((s) => s.name === 'Cart')).toMatchObject({ kind: 'class', fields: [{ name: 'items', type: 'List' }] });
    expect(f.symbols.find((s) => s.qualifiedName === 'Cart.size')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Cart.clear')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'Handler')).toMatchObject({ kind: 'type' });
    expect(f.symbols.find((s) => s.name === '_counter')).toMatchObject({ kind: 'variable', exported: false, typeName: 'int' });
    expect(f.symbols.find((s) => s.name === 'counter')).toMatchObject({ kind: 'variable' });
    expect(f.symbols.find((s) => s.name === 'MyWidget')).toMatchObject({ kind: 'class', extends: ['StatefulWidget'] });
    expect(f.symbols.find((s) => s.name === '_MyWidgetState')).toMatchObject({ kind: 'class', exported: false, extends: ['State'] });
    expect(refs(f, 'Cart.add')).toEqual(['call:log', 'ref:item']);
    expect(refs(f, 'MyWidget.createState')).toEqual(['new:_MyWidgetState']);
    expect(refs(f, '_MyWidgetState.build')).toEqual(['new:Container']);
    expect(f.parseErrors).toBe(0);
  });
});

describe('Lua adapter', () => {
  it('records require imports, module tables, self fields and for-loop locals', async () => {
    const f = await parse(
      'shop/cart.lua',
      `--- A shopping cart.\nlocal M = {}\n\nlocal http = require("socket.http")\nlocal orders = require("shop.orders")\nrequire("shop.setup")\n\nfunction M.greet(name)\n  return "hi " .. name\nend\n\nfunction M:run(n)\n  self.count = n\n  return self:greet("x")\nend\n\nlocal function helper(a, b)\n  return a\nend\n\nlocal function main()\n  for i = 1, 10 do\n    print(i)\n  end\n  for k, v in pairs(items) do\n    M.greet(k)\n  end\n  local svc = Store.new("x")\n  svc:save("done")\n  http.get("https://example.com")\n  orders.checkout("1")\nend\n\nM.version = "1.0"\n\nreturn M\n`,
    );
    expect(imports(f)).toEqual(['socket.http {*>http}', 'shop.orders {*>orders}', 'shop.setup {}']);
    expect(f.symbols.find((s) => s.name === 'M')).toMatchObject({ kind: 'variable', exported: false, doc: 'A shopping cart.' });
    expect(f.symbols.find((s) => s.qualifiedName === 'M.greet')).toMatchObject({ kind: 'method', exported: true });
    expect(f.symbols.find((s) => s.qualifiedName === 'M.run')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'M')?.fields).toEqual([{ name: 'count' }]);
    expect(f.symbols.find((s) => s.name === 'helper')).toMatchObject({ kind: 'function', exported: false });
    expect(f.symbols.find((s) => s.qualifiedName === 'M.version')).toMatchObject({ kind: 'variable' });
    expect(f.symbols.some((s) => s.name === 'http' || s.name === 'orders')).toBe(false);
    expect(f.exports.map((e) => (e.kind === 'local' ? `${e.exported}=${e.local}` : e.kind)).sort()).toEqual(['greet=M.greet', 'run=M.run', 'version=M.version']);
    expect(f.symbols.find((s) => s.name === 'main')).toMatchObject({ locals: { i: 'number', k: 'call:pairs', v: 'call:pairs', svc: 'call:Store.new' } });
    expect(refs(f, 'M.run')).toEqual(['call:this.greet']);
    expect(refs(f, 'main')).toEqual(['call:print', 'ref:i', 'call:pairs', 'ref:items', 'call:M.greet', 'ref:k', 'call:Store.new', 'call:svc.save', 'call:http.get', 'call:orders.checkout']);
    expect(f.references.find((r) => r.callee.join('.') === 'orders.checkout')?.args).toEqual(['1']);
    expect(f.references.find((r) => r.callee.join('.') === 'http.get')?.args).toEqual(['https://example.com']);
    expect(f.references.some((r) => r.callee[0] === 'require')).toBe(false);
    expect(f.parseErrors).toBe(0);
  });

  it('records dot and colon calls, inline table fields and dynamic require', async () => {
    const f = await parse(
      'app/mod.lua',
      `local M = { greet = function(self, n) return self.prefix .. n end }\n\nM.prefix = "> "\n\nfunction M.render(depth)\n  return M.greet(depth)\nend\n\nfunction ping()\n  return M.render(1)\nend\n\nlocal name = "shop." .. suffix\nlocal late = require(name)\nreturn M\n`,
    );
    expect(f.symbols.find((s) => s.qualifiedName === 'M.greet')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'ping')).toMatchObject({ kind: 'function', exported: true });
    expect(refs(f, 'ping')).toEqual(['call:M.render']);
    expect(refs(f, 'M.greet')).toEqual([]);
    expect(refs(f, 'M.render')).toEqual(['call:M.greet', 'ref:depth']);
    expect(f.references.find((r) => r.callee.join('.') === 'require')).toBeDefined();
    expect(f.parseErrors).toBe(0);
  });
});

describe('Vue adapter', () => {
  it('splits script blocks, keeps absolute lines and maps template tags to jsx refs', async () => {
    const f = await parse(
      'src/App.vue',
      `<template>\n  <div>\n    <UserCard :user="user" />\n    <order-list :items="items" />\n    <p>hello</p>\n    <slot />\n  </div>\n</template>\n\n<script setup lang="ts">\nimport { ref } from 'vue';\nimport UserCard from './UserCard.vue';\nimport OrderList from './OrderList.vue';\n\nconst user = ref(null);\n\nfunction reload() {\n  fetchItems();\n}\n</script>\n\n<style scoped>\np { color: red; }\n</style>\n`,
    );
    expect(f.language).toBe('vue');
    expect(imports(f)).toEqual(['vue {ref>ref}', './UserCard.vue {default>UserCard}', './OrderList.vue {default>OrderList}']);
    expect(f.imports.map((i) => i.line)).toEqual([11, 12, 13]);
    expect(f.symbols.find((s) => s.name === 'user')).toMatchObject({ kind: 'variable', startLine: 15, initCall: 'ref' });
    expect(f.symbols.find((s) => s.name === 'reload')).toMatchObject({ kind: 'function', startLine: 17, endLine: 19 });
    expect(refs(f, 'reload')).toEqual(['call:fetchItems']);
    const jsx = f.references.filter((r) => r.kind === 'jsx');
    expect(jsx.map((r) => `${r.callee.join('.')}@${r.line}`)).toEqual(['UserCard@3', 'OrderList@4']);
    expect(f.parseErrors).toBe(0);
  });

  it('merges multiple script blocks and parses options API with absolute lines', async () => {
    const f = await parse(
      'src/CheckoutForm.vue',
      `<script>\nexport const shared = 1;\n</script>\n<script>\nimport { saveOrder } from './api';\n\nexport default {\n  name: 'CheckoutForm',\n  methods: {\n    save() {\n      saveOrder();\n    },\n  },\n};\n</script>\n<template>\n  <button>Save</button>\n</template>\n`,
    );
    expect(imports(f)).toEqual(['./api {saveOrder>saveOrder}']);
    expect(f.imports[0]?.line).toBe(5);
    expect(f.symbols.find((s) => s.name === 'shared')).toMatchObject({ kind: 'variable', exported: true, startLine: 2 });
    expect(f.symbols.find((s) => s.name === 'default')).toMatchObject({ kind: 'variable', exported: true, startLine: 7 });
    expect(f.exports).toEqual([
      { kind: 'local', exported: 'shared', local: 'shared', line: 2 },
      { kind: 'local', exported: 'default', local: 'default', line: 7 },
    ]);
    expect(f.references.some((r) => r.kind === 'call' && r.callee.join('.') === 'saveOrder')).toBe(true);
    expect(f.references.some((r) => r.kind === 'jsx')).toBe(false);
    expect(f.parseErrors).toBe(0);
  });

  it('handles scriptless components and multi-segment kebab tags', async () => {
    const f = await parse('src/Static.vue', `<template>\n  <div>static</div>\n</template>\n`);
    expect(f.language).toBe('vue');
    expect(f.imports).toEqual([]);
    expect(f.symbols).toEqual([]);
    expect(f.references).toEqual([]);
    expect(f.parseErrors).toBe(0);

    const kebab = await parse(
      'src/K.vue',
      `<template>\n  <transition name="fade">\n    <UserCard />\n  </transition>\n  <my-fancy-widget />\n  <component :is="current" />\n</template>\n<script setup>\nimport UserCard from './UserCard.vue';\nimport MyFancyWidget from './MyFancyWidget.vue';\n</script>\n`,
    );
    expect(kebab.references.filter((r) => r.kind === 'jsx').map((r) => `${r.callee.join('.')}@${r.line}`)).toEqual(['UserCard@3', 'MyFancyWidget@5']);
    expect(kebab.parseErrors).toBe(0);
  });

  it('keeps components after nested template wrappers', async () => {
    const f = await parse(
      'src/Nested.vue',
      `<template>\n  <div>\n    <template v-if="ready">\n      <UserCard />\n    </template>\n    <order-list />\n  </div>\n</template>\n<script setup>\nimport UserCard from './UserCard.vue';\nimport OrderList from './OrderList.vue';\n</script>\n`,
    );
    expect(f.references.filter((r) => r.kind === 'jsx').map((r) => `${r.callee.join('.')}@${r.line}`)).toEqual(['UserCard@4', 'OrderList@6']);
    expect(f.parseErrors).toBe(0);
  });
});

describe('Objective-C adapter', () => {
  it('records interfaces, implementations, methods and message sends', async () => {
    const f = await parse(
      'src/Calc.m',
      `#import <Foundation/Foundation.h>\n#import "Calc.h"\n#import "Util/Helper.h"\n\nstatic int next_id = 1;\n\nint add2(int a, int b) {\n    return a + b;\n}\n\n@interface Calc : NSObject <NSCopying> {\n    int _count;\n}\n\n@property (nonatomic, copy) NSString *name;\n@property int count;\n- (int)add:(int)a with:(int)b;\n+ (instancetype)shared;\n\n@end\n\n@implementation Calc\n\n- (instancetype)init {\n    self = [super init];\n    return self;\n}\n\n- (int)add:(int)a with:(int)b {\n    int total = add2(a, b);\n    [self bump];\n    return total;\n}\n\n+ (instancetype)shared {\n    return [[Calc alloc] init];\n}\n\n@end\n\nint main(void) {\n    Calc *c = [[Calc alloc] init];\n    int y = [c add:1 with:2];\n    NSString *n = c.name;\n    [Calc shared];\n    return y;\n}\n`,
    );
    expect(imports(f)).toEqual(['<Foundation/Foundation.h> * {}', 'Calc.h * {}', 'Util/Helper.h * {}']);
    expect(f.symbols.find((s) => s.name === 'Calc')).toMatchObject({
      kind: 'class',
      extends: ['NSObject'],
      implements: ['NSCopying'],
      fields: [
        { name: '_count', type: 'int' },
        { name: 'name', type: 'NSString' },
        { name: 'count', type: 'int' },
      ],
    });
    expect(f.symbols.find((s) => s.qualifiedName === 'Calc.add:with:')).toMatchObject({ kind: 'method', locals: { a: 'int', b: 'int' } });
    expect(f.symbols.find((s) => s.qualifiedName === 'Calc.shared')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'add2')).toMatchObject({ kind: 'function', locals: { a: 'int', b: 'int' } });
    expect(f.symbols.find((s) => s.name === 'next_id')).toMatchObject({ kind: 'variable', exported: false });
    expect(f.symbols.find((s) => s.name === 'main')).toMatchObject({ locals: { c: 'Calc', y: 'int', n: 'NSString' } });
    expect(refs(f, 'Calc.init')).toEqual(['call:super.init']);
    expect(refs(f, 'Calc.add:with:')).toEqual(['call:add2', 'ref:a', 'ref:b', 'call:this.bump']);
    expect(refs(f, 'Calc.shared')).toEqual(['call:Calc.alloc().init', 'call:Calc.alloc']);
    expect(refs(f, 'main')).toEqual(['call:Calc.alloc().init', 'call:Calc.alloc', 'call:c.add:with:', 'call:Calc.shared']);
    expect(f.parseErrors).toBe(0);
  });

  it('records categories, class extensions and protocols', async () => {
    const f = await parse(
      'src/Foo.m',
      `#import "Foo.h"\n\n@protocol Drawable <NSObject>\n- (void)draw;\n@property int lineWidth;\n@optional\n- (void)sketch;\n@end\n\n@interface Foo (Editing)\n- (void)edit;\n@end\n\n@interface Foo ()\n@property (nonatomic) int secret;\n@end\n\n@implementation Foo (Editing)\n- (void)edit {\n    [self draw];\n}\n@end\n`,
    );
    expect(f.symbols.find((s) => s.name === 'Drawable')).toMatchObject({ kind: 'interface', extends: ['NSObject'], fields: [{ name: 'lineWidth', type: 'int' }] });
    expect(f.symbols.find((s) => s.qualifiedName === 'Drawable.draw')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Drawable.sketch')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'Foo(Editing)')).toMatchObject({ kind: 'class' });
    expect(f.symbols.find((s) => s.qualifiedName === 'Foo(Editing).edit')).toMatchObject({ kind: 'method' });
    expect(f.symbols.find((s) => s.name === 'Foo')).toMatchObject({ kind: 'class', fields: [{ name: 'secret', type: 'int' }] });
    expect(refs(f, 'Foo(Editing).edit')).toEqual(['call:this.draw']);
    expect(f.parseErrors).toBe(0);
  });
});
