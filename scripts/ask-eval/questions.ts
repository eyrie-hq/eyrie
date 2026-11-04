/**
 * The Ask eval: ten questions about fixtures/bookstore-app with known answers.
 * Each question names two components by label; the truth is the dependency
 * path between them (archPath over the fixture's graph), and a model's answer
 * scores on the components it cites against that path.
 *
 * Run with a backend: `tsx scripts/ask-eval/run.ts --ai muse`. Needs a signed
 * in backend, so it runs by hand, not in CI; scores are recorded under
 * scripts/ask-eval/results/.
 */
export interface EvalQuestion {
  id: string;
  question: string;
  /** Labels on the fixture's map, resolved at runtime. */
  from: string;
  to: string;
}

export const QUESTIONS: EvalQuestion[] = [
  { id: 'order-page-to-data', question: 'How does the Order Detail Page reach the Order data, step by step?', from: 'Order Detail Page', to: 'Order' },
  { id: 'dashboard-orders', question: 'Where does the Dashboard Page get its order data from?', from: 'Dashboard Page', to: 'Order' },
  { id: 'checkout-payment', question: 'What happens, component by component, when an order checks out toward payment?', from: 'Order Checkout API', to: 'PaymentRouterService' },
  { id: 'recommend-ai', question: 'How do book recommendations reach the AI provider?', from: 'Book Recommend API', to: 'OpenAI' },
  { id: 'order-service-data', question: 'How does the OrderService reach the Order model?', from: 'OrderService', to: 'Order' },
  { id: 'webhook', question: 'How does the Stripe webhook reach the Webhook Service?', from: 'Stripe Webhook API', to: 'Webhook Service' },
  { id: 'payment-stripe', question: 'How does the PaymentService reach Stripe?', from: 'PaymentService', to: 'Stripe' },
  { id: 'paddle', question: 'How does the Paddle payment service reach Paddle?', from: 'PaddlePaymentService', to: 'Paddle' },
  { id: 'order-list-service', question: 'How does the OrderList reach the OrderService?', from: 'OrderList', to: 'OrderService' },
  { id: 'catalog-book', question: 'How does the CatalogService reach the Book model?', from: 'CatalogService', to: 'Book' },
];
