import { describe, expect, it } from 'vitest';
import type { ArchGraph } from '@eyrie/core';
import { emptyProjectConfig } from '@eyrie/graph';
import { memoryIndex } from '@eyrie/graph/testing';
import { deriveArchitecture } from '../src/index.js';
import { isTestFile } from '../src/classify.js';

function readable(graph: ArchGraph) {
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
  return {
    nodes: graph.nodes.map((n) => `${n.lane}:${n.label}`).sort(),
    edges: graph.edges.map((e) => `${label.get(e.source)} -> ${label.get(e.target)}`).sort(),
  };
}

const derive = async (files: Record<string, string>) => deriveArchitecture(await memoryIndex(files, emptyProjectConfig()));

describe('architecture beyond JavaScript', () => {
  it('derives layers for a FastAPI + Django ORM service', async () => {
    const arch = await derive({
      'app/__init__.py': '',
      'app/models.py': `from django.db import models\n\nclass Customer(models.Model):\n    name = models.CharField(max_length=80)\n\nclass Order(models.Model):\n    customer = models.ForeignKey("Customer", on_delete=models.CASCADE)\n`,
      'app/repositories/order_repository.py': `from app.models import Order\n\nclass OrderRepository:\n    def find(self, order_id: int) -> Order:\n        return Order.objects.get(id=order_id)\n`,
      'app/services/order_service.py': `import stripe\nfrom openai import OpenAI\nfrom app.repositories.order_repository import OrderRepository\n\nclass OrderService:\n    """Checks out orders."""\n    def __init__(self, repo: OrderRepository):\n        self.repo = repo\n        self.ai = OpenAI()\n\n    def checkout(self, order_id: int):\n        order = self.repo.find(order_id)\n        stripe.Charge.create(amount=1)\n        self.ai.chat.completions.create(model="gpt")\n        return order\n`,
      'app/api.py': `from fastapi import APIRouter\nfrom app.services.order_service import OrderService\n\nrouter = APIRouter(prefix="/api/orders")\n\n@router.post("/{order_id}/checkout")\ndef checkout(order_id: int):\n    return OrderService(None).checkout(order_id)\n`,
      'tests/test_api.py': `from app.api import checkout\n\ndef test_checkout():\n    checkout(1)\n`,
    });
    expect(readable(arch)).toEqual({
      nodes: ['api:Api Routes', 'data:Customer', 'data:Order', 'data:OrderRepository', 'external:OpenAI', 'external:Stripe', 'logic:OrderService'],
      edges: ['Api Routes -> OrderService', 'OrderRepository -> Order', 'OrderService -> OpenAI', 'OrderService -> OrderRepository', 'OrderService -> Stripe'],
    });
    expect(arch.nodes.find((n) => n.label === 'OrderService')?.summary).toBe('Checks out orders.');
    expect(arch.nodes.find((n) => n.label === 'Order')?.sublabel).toBe('Django model');
  });

  it('derives layers for a Spring service with a Spring Data repository', async () => {
    const arch = await derive({
      'src/main/java/a/web/OrderController.java': `package a.web;\nimport a.order.OrderService;\n@RestController\n@RequestMapping("/api/orders")\npublic class OrderController {\n  private final OrderService service;\n  @PostMapping("/{id}")\n  public void checkout(String id) { service.checkout(id); }\n}\n`,
      'src/main/java/a/order/OrderService.java': `package a.order;\nimport com.stripe.model.Charge;\npublic class OrderService {\n  private final OrderRepository repo;\n  public void checkout(String id) { repo.findById(id); Charge.create(null); }\n}\n`,
      'src/main/java/a/order/OrderRepository.java': `package a.order;\npublic interface OrderRepository extends JpaRepository<Order, Long> {}\n`,
      'src/main/java/a/order/Order.java': `package a.order;\n@Entity\npublic class Order { @Id Long id; }\n`,
      'src/test/java/a/order/OrderServiceTest.java': `package a.order;\nclass OrderServiceTest { void t() { new OrderService().checkout("x"); } }\n`,
    });
    expect(readable(arch)).toEqual({
      nodes: ['api:Order Controller Routes', 'data:Order', 'data:OrderRepository', 'external:Stripe', 'logic:OrderService'],
      edges: ['Order Controller Routes -> OrderService', 'OrderService -> OrderRepository', 'OrderService -> Stripe'],
    });
    expect(arch.nodes.find((n) => n.label === 'Order')?.sublabel).toBe('JPA model');
  });

  it('derives layers for a C service with a CivetWeb front end', async () => {
    const arch = await derive({
      'src/services/order_service.h': `#ifndef ORDER_SERVICE_H\n#define ORDER_SERVICE_H\n\ntypedef struct {\n    int id;\n    double total;\n} Order;\n\n/** Checks out orders. */\nOrder order_checkout(int id) {\n    Order o;\n    o.id = id;\n    o.total = 0;\n    return o;\n}\n\n#endif\n`,
      'src/main.c': `#include "services/order_service.h"\n\nstatic int handle_checkout(void *conn, void *data) {\n    (void)conn;\n    (void)data;\n    Order o = order_checkout(7);\n    (void)o;\n    return 200;\n}\n\nint main(void) {\n    void *ctx = 0;\n    mg_set_request_handler(ctx, "/orders/**", handle_checkout, 0);\n    return 0;\n}\n`,
      'tests/test_order.c': `#include "../src/services/order_service.h"\n\nint main(void) {\n    Order o = order_checkout(1);\n    (void)o;\n    return 0;\n}\n`,
    });
    expect(readable(arch)).toEqual({
      nodes: ['api:Main Routes', 'logic:Order'],
      edges: ['Main Routes -> Order'],
    });
    expect(arch.nodes.find((n) => n.label === 'Order')?.summary).toBe('Checks out orders.');
    expect(arch.nodes.find((n) => n.label === 'Main Routes')?.sublabel).toBe('ANY /orders/**');
  });

  it('recognises test files in the new languages', () => {
    for (const p of ['a/OrderServiceTest.kt', 'a/OrderSpec.kts', 'a/OrderTests.swift', 'tests/t.c', 'a/test_order.c', 'a/order_test.cpp', 'a/x_test.h', 'a/OrderTest.cpp', 'a/order_test.dart', 'a/Order.spec.vue', 'a/OrderTests.m', 'a/test_order.lua', 'a/order_spec.lua']) {
      expect(isTestFile(p)).toBe(true);
    }
    for (const p of ['a/Order.kt', 'a/app.kts', 'a/Order.swift', 'a/order.c', 'a/order.h', 'a/order.cpp', 'a/order.hpp', 'a/order.dart', 'a/Order.vue', 'a/Order.m', 'a/order.lua']) {
      expect(isTestFile(p)).toBe(false);
    }
  });
});
