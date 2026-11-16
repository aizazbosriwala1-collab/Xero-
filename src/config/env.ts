import dotenv from 'dotenv';
dotenv.config();

export const OFFICIAL_AITOOLSHOP_DOC_BASE_URL = 'https://bot.aitoolifystudio.io/api/reseller/v1';
export const DEFAULT_AITOOLSHOP_BASE_URL = 'https://aitoolshop.aitoolifystudio.io/api/reseller/v1';
export const DEFAULT_VENTEBOT_BASE_URL = 'https://api.ventebot.example/v1';
export const DEFAULT_NYSTORE_BASE_URL = 'https://api.nystore.example/v1';
export const DEFAULT_CUPPONSHUB_BASE_URL = 'https://api.cupponshub.example/v1';
export const DEFAULT_ZFOUR_BASE_URL = 'https://api.zfour.example/v1';

export interface ExternalSupplierEnvConfig {
  baseUrl: string;
  baseUrlSource: 'ENV_OVERRIDE' | 'CODE_DEFAULT';
  apiKey?: string;
  webhookSecret?: string;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl?: string;
  redisUrl?: string;
  telegram: {
    botToken?: string;
    botUsername?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    adminIds: string[];
  };
  supplier: {
    baseUrl: string;
    baseUrlSource: 'ENV_OVERRIDE' | 'CODE_DEFAULT';
    officialDocBaseUrl: string;
    apiKey?: string;
  };
  suppliers: {
    ventebot: ExternalSupplierEnvConfig;
    nystore: ExternalSupplierEnvConfig;
    cupponshub: ExternalSupplierEnvConfig;
    zfour: ExternalSupplierEnvConfig;
  };
  binance: {
    enabled: boolean;
    baseUrl: string;
    apiKey?: string;
    apiSecret?: string;
    receiverId?: string;
    recvWindowMs: number;
    requestTimeoutMs: number;
    minDepositUsdt: number;
    maxDepositUsdt: number;
    paymentClockToleranceSeconds: number;
    diagnosticEnabled: boolean;
    readOnlyLiveVerified: boolean;
  };
  safety: {
    recoveryMode: boolean;
    liveOrderingEnabled: boolean;
    manualPaymentsEnabled: boolean;
  };
}

export function parseBoundedClockToleranceSeconds(raw?: string): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return 60;
  }
  return Math.max(0, Math.min(300, parsed));
}

export function parseReadOnlyLiveVerifiedEnv(raw?: string): boolean {
  if (typeof raw !== 'string') {
    return false;
  }
  return raw.trim() === 'true';
}

export function normalizeBotUsername(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^@+/, '')
    .split(/[/?#\s]/)[0]
    .trim();
  return cleaned || undefined;
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const adminIdsRaw = env.TELEGRAM_ADMIN_IDS || '';
  const adminIds = adminIdsRaw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  const explicitSupplierBaseUrl = typeof env.AITOOLSHOP_BASE_URL === 'string' ? env.AITOOLSHOP_BASE_URL.trim() : '';
  const resolvedSupplierBaseUrl = (explicitSupplierBaseUrl || DEFAULT_AITOOLSHOP_BASE_URL).replace(/\/+$/, '');
  const parseExtSupplier = (urlKey: string, keyName: string, defaultUrl: string, secretKey?: string): ExternalSupplierEnvConfig => {
    const rawUrl = typeof env[urlKey] === 'string' ? env[urlKey]!.trim() : '';
    const resolvedUrl = (rawUrl || defaultUrl).replace(/\/+$/, '');
    const rawApiKey = typeof env[keyName] === 'string' && env[keyName]!.trim().length > 0 ? env[keyName]!.trim() : undefined;
    const rawSecret =
      secretKey && typeof env[secretKey] === 'string' && env[secretKey]!.trim().length > 0
        ? env[secretKey]!.trim()
        : undefined;
    return {
      baseUrl: resolvedUrl,
      baseUrlSource: rawUrl ? 'ENV_OVERRIDE' : 'CODE_DEFAULT',
      apiKey: rawApiKey,
      ...(secretKey ? { webhookSecret: rawSecret } : {}),
    };
  };

  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: parseInt(env.PORT || '3000', 10),
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      botUsername: normalizeBotUsername(env.BOT_USERNAME || env.TELEGRAM_BOT_USERNAME),
      webhookUrl: env.TELEGRAM_WEBHOOK_URL,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      adminIds,
    },
    supplier: {
      baseUrl: resolvedSupplierBaseUrl,
      baseUrlSource: explicitSupplierBaseUrl ? 'ENV_OVERRIDE' : 'CODE_DEFAULT',
      officialDocBaseUrl: OFFICIAL_AITOOLSHOP_DOC_BASE_URL,
      apiKey: env.AITOOLSHOP_RESELLER_API_KEY,
    },
    suppliers: {
      ventebot: parseExtSupplier('VENTEBOT_BASE_URL', 'VENTEBOT_API_KEY', DEFAULT_VENTEBOT_BASE_URL),
      nystore: parseExtSupplier('NYSTORE_BASE_URL', 'NYSTORE_API_KEY', DEFAULT_NYSTORE_BASE_URL, 'NYSTORE_WEBHOOK_SECRET'),
      cupponshub: parseExtSupplier('CUPPONSHUB_BASE_URL', 'CUPPONSHUB_API_KEY', DEFAULT_CUPPONSHUB_BASE_URL),
      zfour: parseExtSupplier('ZFOUR_BASE_URL', 'ZFOUR_API_KEY', DEFAULT_ZFOUR_BASE_URL),
    },
    binance: {
      enabled: env.BINANCE_PAY_ENABLED === 'true',
      baseUrl: env.BINANCE_API_BASE_URL || 'https://bpay.binanceapi.com',
      apiKey: env.BINANCE_API_KEY,
      apiSecret: env.BINANCE_API_SECRET,
      receiverId: env.BINANCE_RECEIVER_ID,
      recvWindowMs: parseInt(env.BINANCE_RECV_WINDOW_MS || '5000', 10),
      requestTimeoutMs: parseInt(env.BINANCE_REQUEST_TIMEOUT_MS || '10000', 10),
      minDepositUsdt: parseFloat(env.BINANCE_MIN_DEPOSIT_USDT || '0.10'),
      maxDepositUsdt: parseFloat(env.BINANCE_MAX_DEPOSIT_USDT || '10000.00'),
      paymentClockToleranceSeconds: parseBoundedClockToleranceSeconds(env.BINANCE_PAYMENT_CLOCK_TOLERANCE_SECONDS),
      diagnosticEnabled: env.BINANCE_DIAGNOSTIC_ENABLED === 'true',
      readOnlyLiveVerified: parseReadOnlyLiveVerifiedEnv(env.READ_ONLY_LIVE_VERIFIED),
    },
    safety: {
      recoveryMode: env.RECOVERY_MODE !== 'false', // Defaults to true
      liveOrderingEnabled: env.LIVE_ORDERING_ENABLED === 'true', // Defaults to false
      manualPaymentsEnabled: env.MANUAL_PAYMENTS_ENABLED !== 'false', // Defaults to true
    },
  };
}

export const config: AppConfig = buildConfig(process.env);

/**
 * Returns a sanitized copy of configuration safe for logging and admin diagnostics.
 * Masks all tokens, secrets, private keys, database passwords, and webhook secrets.
 */
export function getSanitizedConfig(): Record<string, unknown> {
  const mask = (val?: string) => {
    if (!val) return 'NOT_CONFIGURED';
    if (val.length <= 8) return '********';
    return `${val.slice(0, 3)}...${val.slice(-3)}`;
  };

  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    databaseConfigured: Boolean(config.databaseUrl),
    redisConfigured: Boolean(config.redisUrl),
    telegram: {
      botToken: mask(config.telegram.botToken),
      botUsername: config.telegram.botUsername || 'AUTO_RESOLVE_GETME',
      webhookUrl: config.telegram.webhookUrl ? 'CONFIGURED' : 'NOT_CONFIGURED',
      webhookSecret: mask(config.telegram.webhookSecret),
      adminCount: config.telegram.adminIds.length,
    },
    supplier: {
      baseUrl: config.supplier.baseUrl,
      baseUrlSource: config.supplier.baseUrlSource,
      officialDocBaseUrl: config.supplier.officialDocBaseUrl,
      apiKeyConfigured: Boolean(config.supplier.apiKey),
    },
    suppliers: {
      ventebot: {
        baseUrl: config.suppliers.ventebot.baseUrl,
        baseUrlSource: config.suppliers.ventebot.baseUrlSource,
        apiKeyConfigured: Boolean(config.suppliers.ventebot.apiKey),
      },
      nystore: {
        baseUrl: config.suppliers.nystore.baseUrl,
        baseUrlSource: config.suppliers.nystore.baseUrlSource,
        apiKeyConfigured: Boolean(config.suppliers.nystore.apiKey),
        webhookSecretConfigured: Boolean(config.suppliers.nystore.webhookSecret),
      },
      cupponshub: {
        baseUrl: config.suppliers.cupponshub.baseUrl,
        baseUrlSource: config.suppliers.cupponshub.baseUrlSource,
        apiKeyConfigured: Boolean(config.suppliers.cupponshub.apiKey),
      },
      zfour: {
        baseUrl: config.suppliers.zfour.baseUrl,
        baseUrlSource: config.suppliers.zfour.baseUrlSource,
        apiKeyConfigured: Boolean(config.suppliers.zfour.apiKey),
      },
    },
    binance: {
      enabled: config.binance.enabled,
      baseUrl: config.binance.baseUrl,
      apiKeyConfigured: Boolean(config.binance.apiKey),
      apiSecretConfigured: Boolean(config.binance.apiSecret),
      receiverId: mask(config.binance.receiverId),
      recvWindowMs: config.binance.recvWindowMs,
      requestTimeoutMs: config.binance.requestTimeoutMs,
      limits: `${config.binance.minDepositUsdt} - ${config.binance.maxDepositUsdt} USDT`,
      paymentClockToleranceSeconds: config.binance.paymentClockToleranceSeconds,
      diagnosticEnabled: config.binance.diagnosticEnabled,
      readOnlyLiveVerified: config.binance.readOnlyLiveVerified,
    },
    safety: { ...config.safety },
  };
}
