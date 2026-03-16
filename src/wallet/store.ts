/**
 * Wallet Storage — Interface + In-Memory Implementation
 *
 * IWalletStore interface allows drop-in replacement with MongoDB later.
 * For the hackathon, InMemoryWalletStore keeps everything in a Map.
 */

export interface StoredWallet {
  telegramId: string;
  address: string;
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
  createdAt: string;
  lastActivity: string;
}

export interface IWalletStore {
  get(telegramId: string): Promise<StoredWallet | null>;
  set(telegramId: string, wallet: StoredWallet): Promise<void>;
  exists(telegramId: string): Promise<boolean>;
  delete(telegramId: string): Promise<void>;
}

export class InMemoryWalletStore implements IWalletStore {
  private wallets = new Map<string, StoredWallet>();

  async get(telegramId: string): Promise<StoredWallet | null> {
    return this.wallets.get(telegramId) || null;
  }

  async set(telegramId: string, wallet: StoredWallet): Promise<void> {
    this.wallets.set(telegramId, wallet);
  }

  async exists(telegramId: string): Promise<boolean> {
    return this.wallets.has(telegramId);
  }

  async delete(telegramId: string): Promise<void> {
    this.wallets.delete(telegramId);
  }
}
