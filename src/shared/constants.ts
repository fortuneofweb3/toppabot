/**
 * Shared constants used across API, MCP, Telegram, and A2A modules.
 * Single source of truth for network identifiers and environment checks.
 */

export const IS_TESTNET = process.env.NODE_ENV !== 'production';

// CAIP-2 network identifiers (https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
export const CELO_CAIP2 = IS_TESTNET ? 'eip155:44787' : 'eip155:42220';

// Token display symbol
export const TOKEN_SYMBOL = IS_TESTNET ? 'USDC' : 'cUSD';

// Block explorer base URLs
export const EXPLORER_BASE = IS_TESTNET
  ? 'https://alfajores.celoscan.io'
  : 'https://celoscan.io';
