import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createWalletClient, createPublicClient, http, parseAbi,
  formatUnits, parseUnits,
} from 'viem';
import { celo, celoSepolia } from 'viem/chains';
import { encryptPrivateKey, decryptPrivateKey } from './crypto';
import { IWalletStore, StoredWallet } from './store';
import {
  PAYMENT_TOKEN_ADDRESS, PAYMENT_TOKEN_DECIMALS,
} from '../blockchain/x402';

/**
 * WalletManager — Create, fund, transfer, withdraw, and export user wallets
 *
 * Uses Celo's feeCurrency for gas abstraction on mainnet (users only need cUSD).
 * On testnet (Sepolia with USDC), feeCurrency may not be supported — omitted.
 */

const isTestnet = process.env.NODE_ENV !== 'production';
const chain = isTestnet ? celoSepolia : celo;

// Only use feeCurrency on mainnet (cUSD is whitelisted, USDC on Sepolia is not)
const FEE_CURRENCY = isTestnet ? undefined : PAYMENT_TOKEN_ADDRESS;

// Safety caps — prevent catastrophic transfers from bugs or compromised inputs
const MAX_SINGLE_TRANSFER_USD = 1000;   // Max per-transaction (cUSD)
const MAX_SINGLE_WITHDRAWAL_USD = 500;  // Max per-withdrawal (cUSD)

const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

export class WalletManager {
  private store: IWalletStore;
  private publicClient: any; // viem PublicClient — typed as any due to Celo chain type conflicts

  constructor(store: IWalletStore) {
    this.store = store;
    this.publicClient = createPublicClient({
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });
  }

  /**
   * Get or create a wallet for a Telegram user.
   * Creates on first use, returns existing on subsequent calls.
   */
  async getOrCreateWallet(telegramId: string): Promise<{
    address: string;
    isNew: boolean;
  }> {
    const existing = await this.store.get(telegramId);
    if (existing) {
      return { address: existing.address, isNew: false };
    }

    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const { encrypted, iv, authTag } = encryptPrivateKey(privateKey);

    const wallet: StoredWallet = {
      telegramId,
      address: account.address,
      encryptedPrivateKey: encrypted,
      iv,
      authTag,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };

    // Atomic insert: if another request raced and created a wallet first,
    // insertIfAbsent returns the existing wallet (no overwrite / key loss).
    const stored = await this.store.insertIfAbsent(telegramId, wallet);
    const isNew = stored.address === account.address;
    return { address: stored.address, isNew };
  }

  /**
   * Get cUSD/USDC balance for a user's wallet
   */
  async getBalance(telegramId: string): Promise<{
    balance: string;
    balanceRaw: bigint;
    address: string;
  }> {
    const wallet = await this.store.get(telegramId);
    if (!wallet) throw new Error('No wallet found. Send /start first.');

    const balanceRaw = await this.publicClient.readContract({
      address: PAYMENT_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet.address as `0x${string}`],
    }) as bigint;

    return {
      balance: formatUnits(balanceRaw, PAYMENT_TOKEN_DECIMALS),
      balanceRaw,
      address: wallet.address,
    };
  }

  /**
   * Transfer cUSD from user's wallet to Toppa agent wallet (x402 payment).
   * Uses feeCurrency on mainnet so gas is paid in cUSD (no CELO needed).
   */
  async transferToAgent(
    telegramId: string,
    amountUsd: number,
  ): Promise<{ txHash: string; amount: string }> {
    if (!amountUsd || !isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error('Invalid transfer amount');
    }
    if (amountUsd > MAX_SINGLE_TRANSFER_USD) {
      throw new Error(`Transfer amount $${amountUsd} exceeds maximum $${MAX_SINGLE_TRANSFER_USD}`);
    }

    const wallet = await this.store.get(telegramId);
    if (!wallet) throw new Error('No wallet found');

    const privateKey = decryptPrivateKey(wallet.encryptedPrivateKey, wallet.iv, wallet.authTag);
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });

    const agentWallet = process.env.AGENT_WALLET_ADDRESS as `0x${string}`;
    if (!agentWallet || !/^0x[0-9a-fA-F]{40}$/.test(agentWallet)) {
      throw new Error('Agent wallet address not configured');
    }
    const amountWei = parseUnits(amountUsd.toFixed(PAYMENT_TOKEN_DECIMALS > 6 ? 8 : 6), PAYMENT_TOKEN_DECIMALS);

    // Check balance
    const balance = await this.publicClient.readContract({
      address: PAYMENT_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    }) as bigint;

    if (balance < amountWei) {
      throw new Error(
        `Insufficient balance: ${formatUnits(balance, PAYMENT_TOKEN_DECIMALS)} cUSD available, ` +
        `${amountUsd} cUSD needed. Deposit to: ${wallet.address}`,
      );
    }

    // Execute ERC-20 transfer (feeCurrency for gas abstraction on mainnet)
    const hash = await walletClient.writeContract({
      address: PAYMENT_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [agentWallet, amountWei],
      ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
    } as any);

    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

    return { txHash: hash, amount: amountUsd.toString() };
  }

  /**
   * Withdraw cUSD from user's wallet to an external address.
   */
  async withdraw(
    telegramId: string,
    toAddress: string,
    amountUsd: number,
  ): Promise<{ txHash: string; amount: string; to: string }> {
    if (!amountUsd || !isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error('Invalid withdrawal amount');
    }
    if (amountUsd > MAX_SINGLE_WITHDRAWAL_USD) {
      throw new Error(`Withdrawal amount $${amountUsd} exceeds maximum $${MAX_SINGLE_WITHDRAWAL_USD}`);
    }
    if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
      throw new Error('Invalid destination address');
    }

    const wallet = await this.store.get(telegramId);
    if (!wallet) throw new Error('No wallet found');

    const privateKey = decryptPrivateKey(wallet.encryptedPrivateKey, wallet.iv, wallet.authTag);
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });

    const amountWei = parseUnits(amountUsd.toFixed(PAYMENT_TOKEN_DECIMALS > 6 ? 8 : 6), PAYMENT_TOKEN_DECIMALS);

    const balance = await this.publicClient.readContract({
      address: PAYMENT_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    }) as bigint;

    if (balance < amountWei) {
      throw new Error(
        `Insufficient balance for withdrawal: ${formatUnits(balance, PAYMENT_TOKEN_DECIMALS)} cUSD available`,
      );
    }

    const hash = await walletClient.writeContract({
      address: PAYMENT_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [toAddress as `0x${string}`, amountWei],
      ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
    } as any);

    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

    return { txHash: hash, amount: amountUsd.toString(), to: toAddress };
  }

  /**
   * Export user's private key (decrypted). Only called by explicit /export command.
   */
  async exportPrivateKey(telegramId: string): Promise<string> {
    const wallet = await this.store.get(telegramId);
    if (!wallet) throw new Error('No wallet found');
    return decryptPrivateKey(wallet.encryptedPrivateKey, wallet.iv, wallet.authTag);
  }

  /**
   * Refund cUSD from agent wallet back to a Telegram user's managed wallet.
   * Used when payment succeeds but service execution fails.
   */
  async refundUser(
    telegramId: string,
    amountUsd: number,
    paymentTxHash?: string,
  ): Promise<{ txHash: string; amount: string }> {
    if (!amountUsd || !isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error('Invalid refund amount');
    }
    if (amountUsd > MAX_SINGLE_TRANSFER_USD) {
      throw new Error(`Refund amount $${amountUsd} exceeds safety cap`);
    }
    const wallet = await this.store.get(telegramId);
    if (!wallet) throw new Error('No wallet found for refund');

    const { refundPayer } = await import('../shared/refund');
    const txHash = await refundPayer(wallet.address, amountUsd, 'telegram', paymentTxHash);
    if (!txHash) throw new Error('Refund transaction failed');
    return { txHash, amount: amountUsd.toString() };
  }

  /**
   * Get wallet address without decryption
   */
  async getAddress(telegramId: string): Promise<string | null> {
    const wallet = await this.store.get(telegramId);
    return wallet?.address || null;
  }
}
