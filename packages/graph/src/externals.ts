/**
 * Known third-party services, recognised by package name or API host.
 * Imports of these packages become `external_service` nodes so the
 * architecture graph can show "AI Service → OpenAI" without AI guessing.
 */
import { ownValue } from '@eyrie/core';

export type ExternalCategory =
  | 'ai'
  | 'database'
  | 'payments'
  | 'auth'
  | 'email'
  | 'storage'
  | 'queue'
  | 'analytics'
  | 'messaging'
  | 'search'
  | 'api';

export interface ExternalProvider {
  id: string;
  label: string;
  category: ExternalCategory;
}

const P = (id: string, label: string, category: ExternalCategory): ExternalProvider => ({ id, label, category });

const PROVIDERS = {
  openai: P('openai', 'OpenAI', 'ai'),
  anthropic: P('anthropic', 'Anthropic', 'ai'),
  gemini: P('gemini', 'Google Gemini', 'ai'),
  vercelAi: P('vercel-ai', 'Vercel AI SDK', 'ai'),
  langchain: P('langchain', 'LangChain', 'ai'),
  mistral: P('mistral', 'Mistral', 'ai'),
  cohere: P('cohere', 'Cohere', 'ai'),
  groq: P('groq', 'Groq', 'ai'),
  replicate: P('replicate', 'Replicate', 'ai'),
  ollama: P('ollama', 'Ollama', 'ai'),
  pinecone: P('pinecone', 'Pinecone', 'ai'),
  stripe: P('stripe', 'Stripe', 'payments'),
  lemonsqueezy: P('lemonsqueezy', 'Lemon Squeezy', 'payments'),
  paddle: P('paddle', 'Paddle', 'payments'),
  prisma: P('prisma', 'Prisma', 'database'),
  drizzle: P('drizzle', 'Drizzle ORM', 'database'),
  mongodb: P('mongodb', 'MongoDB', 'database'),
  postgres: P('postgres', 'PostgreSQL', 'database'),
  mysql: P('mysql', 'MySQL', 'database'),
  sqlite: P('sqlite', 'SQLite', 'database'),
  supabase: P('supabase', 'Supabase', 'database'),
  firebase: P('firebase', 'Firebase', 'database'),
  redis: P('redis', 'Redis', 'database'),
  convex: P('convex', 'Convex', 'database'),
  s3: P('aws-s3', 'AWS S3', 'storage'),
  aws: P('aws', 'AWS', 'api'),
  cloudinary: P('cloudinary', 'Cloudinary', 'storage'),
  uploadthing: P('uploadthing', 'UploadThing', 'storage'),
  resend: P('resend', 'Resend', 'email'),
  sendgrid: P('sendgrid', 'SendGrid', 'email'),
  smtp: P('smtp', 'SMTP (Nodemailer)', 'email'),
  postmark: P('postmark', 'Postmark', 'email'),
  twilio: P('twilio', 'Twilio', 'messaging'),
  slack: P('slack', 'Slack', 'messaging'),
  clerk: P('clerk', 'Clerk', 'auth'),
  nextAuth: P('nextauth', 'Auth.js', 'auth'),
  betterAuth: P('better-auth', 'Better Auth', 'auth'),
  auth0: P('auth0', 'Auth0', 'auth'),
  bullmq: P('bullmq', 'BullMQ', 'queue'),
  inngest: P('inngest', 'Inngest', 'queue'),
  trigger: P('trigger', 'Trigger.dev', 'queue'),
  sentry: P('sentry', 'Sentry', 'analytics'),
  posthog: P('posthog', 'PostHog', 'analytics'),
  algolia: P('algolia', 'Algolia', 'search'),
  github: P('github', 'GitHub API', 'api'),
  google: P('google-apis', 'Google APIs', 'api'),
  celery: P('celery', 'Celery', 'queue'),
  sidekiq: P('sidekiq', 'Sidekiq', 'queue'),
  rabbitmq: P('rabbitmq', 'RabbitMQ', 'queue'),
  kafka: P('kafka', 'Kafka', 'queue'),
  elasticsearch: P('elasticsearch', 'Elasticsearch', 'search'),
} satisfies Record<string, ExternalProvider>;

const PACKAGES: Record<string, ExternalProvider> = {
  openai: PROVIDERS.openai,
  '@ai-sdk/openai': PROVIDERS.openai,
  '@anthropic-ai/sdk': PROVIDERS.anthropic,
  '@ai-sdk/anthropic': PROVIDERS.anthropic,
  '@google/generative-ai': PROVIDERS.gemini,
  '@google/genai': PROVIDERS.gemini,
  '@ai-sdk/google': PROVIDERS.gemini,
  ai: PROVIDERS.vercelAi,
  langchain: PROVIDERS.langchain,
  '@mistralai/mistralai': PROVIDERS.mistral,
  'cohere-ai': PROVIDERS.cohere,
  'groq-sdk': PROVIDERS.groq,
  replicate: PROVIDERS.replicate,
  ollama: PROVIDERS.ollama,
  '@pinecone-database/pinecone': PROVIDERS.pinecone,
  stripe: PROVIDERS.stripe,
  '@stripe/stripe-js': PROVIDERS.stripe,
  '@lemonsqueezy/lemonsqueezy.js': PROVIDERS.lemonsqueezy,
  '@paddle/paddle-node-sdk': PROVIDERS.paddle,
  '@prisma/client': PROVIDERS.prisma,
  'drizzle-orm': PROVIDERS.drizzle,
  mongoose: PROVIDERS.mongodb,
  mongodb: PROVIDERS.mongodb,
  pg: PROVIDERS.postgres,
  postgres: PROVIDERS.postgres,
  '@neondatabase/serverless': PROVIDERS.postgres,
  '@vercel/postgres': PROVIDERS.postgres,
  mysql2: PROVIDERS.mysql,
  'better-sqlite3': PROVIDERS.sqlite,
  '@libsql/client': PROVIDERS.sqlite,
  '@supabase/supabase-js': PROVIDERS.supabase,
  '@supabase/ssr': PROVIDERS.supabase,
  firebase: PROVIDERS.firebase,
  'firebase-admin': PROVIDERS.firebase,
  redis: PROVIDERS.redis,
  ioredis: PROVIDERS.redis,
  '@upstash/redis': PROVIDERS.redis,
  convex: PROVIDERS.convex,
  '@aws-sdk/client-s3': PROVIDERS.s3,
  cloudinary: PROVIDERS.cloudinary,
  uploadthing: PROVIDERS.uploadthing,
  resend: PROVIDERS.resend,
  '@sendgrid/mail': PROVIDERS.sendgrid,
  nodemailer: PROVIDERS.smtp,
  postmark: PROVIDERS.postmark,
  twilio: PROVIDERS.twilio,
  '@slack/web-api': PROVIDERS.slack,
  '@clerk/nextjs': PROVIDERS.clerk,
  '@clerk/clerk-sdk-node': PROVIDERS.clerk,
  'next-auth': PROVIDERS.nextAuth,
  '@auth/core': PROVIDERS.nextAuth,
  'better-auth': PROVIDERS.betterAuth,
  '@auth0/nextjs-auth0': PROVIDERS.auth0,
  bullmq: PROVIDERS.bullmq,
  bull: PROVIDERS.bullmq,
  inngest: PROVIDERS.inngest,
  '@trigger.dev/sdk': PROVIDERS.trigger,
  '@sentry/nextjs': PROVIDERS.sentry,
  '@sentry/node': PROVIDERS.sentry,
  'posthog-js': PROVIDERS.posthog,
  'posthog-node': PROVIDERS.posthog,
  algoliasearch: PROVIDERS.algolia,
  octokit: PROVIDERS.github,
  '@octokit/rest': PROVIDERS.github,
  googleapis: PROVIDERS.google,
};

const HOSTS: Record<string, ExternalProvider> = {
  'api.openai.com': PROVIDERS.openai,
  'api.anthropic.com': PROVIDERS.anthropic,
  'generativelanguage.googleapis.com': PROVIDERS.gemini,
  'api.stripe.com': PROVIDERS.stripe,
  'api.github.com': PROVIDERS.github,
  'hooks.slack.com': PROVIDERS.slack,
  'slack.com': PROVIDERS.slack,
  'api.resend.com': PROVIDERS.resend,
  'api.sendgrid.com': PROVIDERS.sendgrid,
  'api.twilio.com': PROVIDERS.twilio,
};

/** `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * SDKs of other ecosystems, by the name code imports them under: Python
 * modules, Go module paths, Java / C# / PHP namespaces, Ruby requires and
 * Rust crates. Matched as a prefix ending at a separator (`.`, `/`, `::`).
 */
const QUALIFIED: [string, ExternalProvider][] = [
  // Python
  ['openai', PROVIDERS.openai],
  ['anthropic', PROVIDERS.anthropic],
  ['google.generativeai', PROVIDERS.gemini],
  ['google.genai', PROVIDERS.gemini],
  ['vertexai', PROVIDERS.gemini],
  ['langchain', PROVIDERS.langchain],
  ['langchain_core', PROVIDERS.langchain],
  ['langchain_openai', PROVIDERS.langchain],
  ['langchain_community', PROVIDERS.langchain],
  ['mistralai', PROVIDERS.mistral],
  ['cohere', PROVIDERS.cohere],
  ['groq', PROVIDERS.groq],
  ['pinecone', PROVIDERS.pinecone],
  ['psycopg2', PROVIDERS.postgres],
  ['psycopg', PROVIDERS.postgres],
  ['asyncpg', PROVIDERS.postgres],
  ['pymysql', PROVIDERS.mysql],
  ['mysql.connector', PROVIDERS.mysql],
  ['sqlite3', PROVIDERS.sqlite],
  ['pymongo', PROVIDERS.mongodb],
  ['motor', PROVIDERS.mongodb],
  ['supabase', PROVIDERS.supabase],
  ['firebase_admin', PROVIDERS.firebase],
  ['boto3', PROVIDERS.aws],
  ['botocore', PROVIDERS.aws],
  ['sendgrid', PROVIDERS.sendgrid],
  ['smtplib', PROVIDERS.smtp],
  ['slack_sdk', PROVIDERS.slack],
  ['sentry_sdk', PROVIDERS.sentry],
  ['posthog', PROVIDERS.posthog],
  ['algoliasearch', PROVIDERS.algolia],
  ['github', PROVIDERS.github],
  ['googleapiclient', PROVIDERS.google],
  ['celery', PROVIDERS.celery],
  ['pika', PROVIDERS.rabbitmq],
  ['kafka', PROVIDERS.kafka],
  ['confluent_kafka', PROVIDERS.kafka],
  ['elasticsearch', PROVIDERS.elasticsearch],
  // Go
  ['github.com/sashabaranov/go-openai', PROVIDERS.openai],
  ['github.com/openai/openai-go', PROVIDERS.openai],
  ['github.com/anthropics/anthropic-sdk-go', PROVIDERS.anthropic],
  ['github.com/google/generative-ai-go', PROVIDERS.gemini],
  ['google.golang.org/genai', PROVIDERS.gemini],
  ['github.com/tmc/langchaingo', PROVIDERS.langchain],
  ['github.com/stripe/stripe-go', PROVIDERS.stripe],
  ['github.com/jackc/pgx', PROVIDERS.postgres],
  ['github.com/lib/pq', PROVIDERS.postgres],
  ['github.com/go-sql-driver/mysql', PROVIDERS.mysql],
  ['github.com/mattn/go-sqlite3', PROVIDERS.sqlite],
  ['modernc.org/sqlite', PROVIDERS.sqlite],
  ['go.mongodb.org/mongo-driver', PROVIDERS.mongodb],
  ['github.com/redis/go-redis', PROVIDERS.redis],
  ['github.com/go-redis/redis', PROVIDERS.redis],
  ['github.com/aws/aws-sdk-go-v2/service/s3', PROVIDERS.s3],
  ['github.com/aws/aws-sdk-go-v2', PROVIDERS.aws],
  ['github.com/aws/aws-sdk-go', PROVIDERS.aws],
  ['firebase.google.com/go', PROVIDERS.firebase],
  ['github.com/twilio/twilio-go', PROVIDERS.twilio],
  ['github.com/slack-go/slack', PROVIDERS.slack],
  ['github.com/getsentry/sentry-go', PROVIDERS.sentry],
  ['github.com/sendgrid/sendgrid-go', PROVIDERS.sendgrid],
  ['github.com/resend/resend-go', PROVIDERS.resend],
  ['github.com/google/go-github', PROVIDERS.github],
  ['github.com/rabbitmq/amqp091-go', PROVIDERS.rabbitmq],
  ['github.com/segmentio/kafka-go', PROVIDERS.kafka],
  ['github.com/IBM/sarama', PROVIDERS.kafka],
  ['github.com/elastic/go-elasticsearch', PROVIDERS.elasticsearch],
  // Java / Kotlin
  ['com.openai', PROVIDERS.openai],
  ['com.theokanning.openai', PROVIDERS.openai],
  ['com.anthropic', PROVIDERS.anthropic],
  ['com.google.cloud.vertexai', PROVIDERS.gemini],
  ['com.google.genai', PROVIDERS.gemini],
  ['dev.langchain4j', PROVIDERS.langchain],
  ['org.springframework.ai', PROVIDERS.openai],
  ['com.stripe', PROVIDERS.stripe],
  ['software.amazon.awssdk.services.s3', PROVIDERS.s3],
  ['software.amazon.awssdk', PROVIDERS.aws],
  ['com.amazonaws', PROVIDERS.aws],
  ['com.twilio', PROVIDERS.twilio],
  ['com.sendgrid', PROVIDERS.sendgrid],
  ['redis.clients.jedis', PROVIDERS.redis],
  ['io.lettuce', PROVIDERS.redis],
  ['org.springframework.data.redis', PROVIDERS.redis],
  ['com.mongodb', PROVIDERS.mongodb],
  ['org.springframework.data.mongodb', PROVIDERS.mongodb],
  ['org.postgresql', PROVIDERS.postgres],
  ['com.mysql', PROVIDERS.mysql],
  ['com.google.firebase', PROVIDERS.firebase],
  ['io.sentry', PROVIDERS.sentry],
  ['com.slack.api', PROVIDERS.slack],
  ['com.algolia', PROVIDERS.algolia],
  ['org.kohsuke.github', PROVIDERS.github],
  ['org.springframework.amqp', PROVIDERS.rabbitmq],
  ['com.rabbitmq', PROVIDERS.rabbitmq],
  ['org.apache.kafka', PROVIDERS.kafka],
  ['org.springframework.kafka', PROVIDERS.kafka],
  ['co.elastic.clients', PROVIDERS.elasticsearch],
  ['org.springframework.mail', PROVIDERS.smtp],
  ['jakarta.mail', PROVIDERS.smtp],
  // C#
  ['OpenAI', PROVIDERS.openai],
  ['Azure.AI.OpenAI', PROVIDERS.openai],
  ['Anthropic', PROVIDERS.anthropic],
  ['Google.Cloud.AIPlatform', PROVIDERS.gemini],
  ['Google.GenAI', PROVIDERS.gemini],
  ['Microsoft.SemanticKernel', PROVIDERS.openai],
  ['Stripe', PROVIDERS.stripe],
  ['Amazon.S3', PROVIDERS.s3],
  ['Amazon', PROVIDERS.aws],
  ['Twilio', PROVIDERS.twilio],
  ['SendGrid', PROVIDERS.sendgrid],
  ['StackExchange.Redis', PROVIDERS.redis],
  ['MongoDB.Driver', PROVIDERS.mongodb],
  ['Npgsql', PROVIDERS.postgres],
  ['MySql.Data', PROVIDERS.mysql],
  ['MySqlConnector', PROVIDERS.mysql],
  ['Microsoft.Data.Sqlite', PROVIDERS.sqlite],
  ['FirebaseAdmin', PROVIDERS.firebase],
  ['Sentry', PROVIDERS.sentry],
  ['Algolia.Search', PROVIDERS.algolia],
  ['Octokit', PROVIDERS.github],
  ['RabbitMQ.Client', PROVIDERS.rabbitmq],
  ['MassTransit', PROVIDERS.rabbitmq],
  ['Confluent.Kafka', PROVIDERS.kafka],
  ['Elastic.Clients.Elasticsearch', PROVIDERS.elasticsearch],
  ['MailKit', PROVIDERS.smtp],
  ['Resend', PROVIDERS.resend],
  ['Postmark', PROVIDERS.postmark],
  // PHP (namespaces, `\` normalised to `.`)
  ['OpenAI', PROVIDERS.openai],
  ['Anthropic', PROVIDERS.anthropic],
  ['Gemini', PROVIDERS.gemini],
  ['Stripe', PROVIDERS.stripe],
  ['Aws.S3', PROVIDERS.s3],
  ['Aws', PROVIDERS.aws],
  ['Twilio', PROVIDERS.twilio],
  ['SendGrid', PROVIDERS.sendgrid],
  ['Predis', PROVIDERS.redis],
  ['Illuminate.Support.Facades.Redis', PROVIDERS.redis],
  ['MongoDB', PROVIDERS.mongodb],
  ['Kreait.Firebase', PROVIDERS.firebase],
  ['Sentry', PROVIDERS.sentry],
  ['Algolia', PROVIDERS.algolia],
  ['Github', PROVIDERS.github],
  ['Resend', PROVIDERS.resend],
  ['Postmark', PROVIDERS.postmark],
  ['Illuminate.Support.Facades.Mail', PROVIDERS.smtp],
  ['PHPMailer', PROVIDERS.smtp],
  ['PhpAmqpLib', PROVIDERS.rabbitmq],
  ['Elastic.Elasticsearch', PROVIDERS.elasticsearch],
  // Ruby
  ['ruby/openai', PROVIDERS.openai],
  ['aws-sdk-s3', PROVIDERS.s3],
  ['aws-sdk', PROVIDERS.aws],
  ['twilio-ruby', PROVIDERS.twilio],
  ['sendgrid-ruby', PROVIDERS.sendgrid],
  ['sqlite3', PROVIDERS.sqlite],
  ['mongo', PROVIDERS.mongodb],
  ['mongoid', PROVIDERS.mongodb],
  ['sentry-ruby', PROVIDERS.sentry],
  ['slack-ruby-client', PROVIDERS.slack],
  ['sidekiq', PROVIDERS.sidekiq],
  ['bunny', PROVIDERS.rabbitmq],
  ['net/smtp', PROVIDERS.smtp],
  // Rust
  ['async_openai', PROVIDERS.openai],
  ['async_stripe', PROVIDERS.stripe],
  ['aws_sdk_s3', PROVIDERS.s3],
  ['aws_config', PROVIDERS.aws],
  ['tokio_postgres', PROVIDERS.postgres],
  ['rusqlite', PROVIDERS.sqlite],
  ['sentry', PROVIDERS.sentry],
  ['lapin', PROVIDERS.rabbitmq],
  ['rdkafka', PROVIDERS.kafka],
  ['lettre', PROVIDERS.smtp],
];

export function providerForPackage(specifier: string): ExternalProvider | null {
  const name = packageName(specifier);
  const known = ownValue(PACKAGES, name);
  if (known) return known;
  if (name.startsWith('@langchain/')) return PROVIDERS.langchain;
  if (name.startsWith('@aws-sdk/')) return PROVIDERS.aws;
  // Match within the specifier's own style, so Go's `github.com/x` is not Python's `github`.
  const sep = specifier.includes('/') ? '/' : specifier.includes('::') ? '::' : '.';
  let best: [string, ExternalProvider] | undefined;
  for (const entry of QUALIFIED) {
    const [prefix] = entry;
    const hit = specifier === prefix || specifier.startsWith(prefix + sep);
    if (hit && (!best || prefix.length > best[0].length)) best = entry;
  }
  return best?.[1] ?? null;
}

export function providerForUrl(url: string): ExternalProvider | null {
  if (/^https?:\/\/:param/.test(url)) return null;
  let host: string;
  try {
    // Template placeholders follow the host (`${base}/path`) or form it (`https://${host}`).
    host = new URL(url.replace(/:param/g, '')).hostname;
  } catch {
    return null;
  }
  if (!host || host === 'localhost' || host === '127.0.0.1') return null;
  return ownValue(HOSTS, host) ?? { id: `host:${host}`, label: host, category: 'api' };
}
