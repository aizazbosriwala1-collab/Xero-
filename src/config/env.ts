import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl?: string;
  redisUrl?: string;
  telegram: {
    botToken?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    adminIds: string[];
  };
  supplier: {
    baseUrl: string;
    apiKey?: string;
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
    diagnosticEnabled: boolean;
  };
  safety: {
    recoveryMode: boolean;
    liveOrderingEnabled: boolean;
    manualPaymentsEnabled: boolean;
  };
}

const adminIdsRaw = process.env.TELEGRAM_ADMIN_IDS || '';
const adminIds = adminIdsRaw
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

export const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    adminIds,
  },
  supplier: {
    baseUrl: process.env.AITOOLSHOP_BASE_URL || 'https://aitoolshop.aitoolifystudio.io/api/reseller/v1',
    apiKey: process.env.AITOOLSHOP_RESELLER_API_KEY,
  },
  binance: {
    enabled: process.env.BINANCE_PAY_ENABLED === 'true',
    baseUrl: process.env.BINANCE_API_BASE_URL || 'https://bpay.binanceapi.com',
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    receiverId: process.env.BINANCE_RECEIVER_ID,
    recvWindowMs: parseInt(process.env.BINANCE_RECV_WINDOW_MS || '5000', 10),
    requestTimeoutMs: parseInt(process.env.BINANCE_REQUEST_TIMEOUT_MS || '10000', 10),
    minDepositUsdt: parseFloat(process.env.BINANCE_MIN_DEPOSIT_USDT || '0.10'),
    maxDepositUsdt: parseFloat(process.env.BINANCE_MAX_DEPOSIT_USDT || '10000.00'),
    diagnosticEnabled: process.env.BINANCE_DIAGNOSTIC_ENABLED === 'true',
  },
  safety: {
    recoveryMode: process.env.RECOVERY_MODE !== 'false', // Defaults to true
    liveOrderingEnabled: process.env.LIVE_ORDERING_ENABLED === 'true', // Defaults to false
    manualPaymentsEnabled: process.env.MANUAL_PAYMENTS_ENABLED !== 'false', // Defaults to true
  },
};

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
      webhookUrl: config.telegram.webhookUrl ? 'CONFIGURED' : 'NOT_CONFIGURED',
      webhookSecret: mask(config.telegram.webhookSecret),
      adminCount: config.telegram.adminIds.length,
    },
    supplier: {
      baseUrl: config.supplier.baseUrl,
      apiKeyConfigured: Boolean(config.supplier.apiKey),
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
      diagnosticEnabled: config.binance.diagnosticEnabled,
    },
    safety: { ...config.safety },
  };
}
