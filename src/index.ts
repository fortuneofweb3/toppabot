// Load environment variables FIRST (before any other imports)
import 'dotenv/config';

import { startTelegramBot } from './bot/telegram';
import { startApiServer, app } from './api/server';
import { closeMongoConnection } from './wallet/mongo-store';

/**
 * Main entry point for Toppa Agent
 *
 * Toppa runs two interfaces:
 * 1. Telegram Bot - for human users (chat-based)
 * 2. HTTP API    - for other agents (x402 payment-gated)
 */
async function main() {
  console.log('🚀 Starting Toppa Agent...');
  console.log('   "Toppa" = top-up, powered by Celo');
  console.log('');

  // Validate core environment variables
  const isProduction = process.env.NODE_ENV === 'production';
  const required = ['LLM_API_KEY', 'CELO_RPC_URL', 'CELO_PRIVATE_KEY', 'AGENT_WALLET_ADDRESS', 'WALLET_ENCRYPTION_KEY'];
  const missing = required.filter(env => !process.env[env] || process.env[env]?.startsWith('your_'));

  if (missing.length > 0) {
    console.error(`❌ Missing critical environment variables: ${missing.join(', ')}`);
    if (isProduction) {
      console.error('Cannot start in production without required env vars. Exiting.');
      process.exit(1);
    } else {
      console.warn('⚠️  Running in dev mode with missing env vars - some features may not work');
    }
  }

  // Start HTTP API server (for agent-to-agent x402 interactions)
  const server = startApiServer();

  // Start Telegram bot only if token is configured
  if (process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.startsWith('your_')) {
    await startTelegramBot(app);
  } else {
    console.log('Telegram bot skipped (no TELEGRAM_BOT_TOKEN configured)');
  }

  console.log('');
  console.log('✅ Toppa is live!');
  console.log('💬 Telegram: Send messages to your bot');
  console.log('🤖 API: Other agents can call via x402');

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Gracefully shutting down...`);
    await closeMongoConnection();
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });

    // Force shutdown after 30 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run the application
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
