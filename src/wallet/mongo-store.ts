import { MongoClient, Collection, Db } from 'mongodb';
import { IWalletStore, StoredWallet } from './store';

/**
 * MongoDB Wallet Store — Persistent wallet storage
 *
 * Drop-in replacement for InMemoryWalletStore.
 * Wallets survive server restarts.
 */

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (_db) return _db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not configured');

  // serverApi + tls options help with Atlas SSL compatibility across Node.js versions
  _client = new MongoClient(uri, {
    tls: true,
    // Retry on transient network/SSL errors
    retryWrites: true,
    retryReads: true,
    // Connection pool settings
    maxPoolSize: 10,
    minPoolSize: 1,
    // Timeout settings
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 30000,
  });
  await _client.connect();
  _db = _client.db(); // Uses db name from URI (toppa)
  console.log('Connected to MongoDB');
  return _db;
}

export class MongoWalletStore implements IWalletStore {
  private collectionName = 'wallets';
  private _collection: Collection<StoredWallet> | null = null;

  private async collection(): Promise<Collection<StoredWallet>> {
    if (this._collection) return this._collection;
    const db = await getDb();
    this._collection = db.collection<StoredWallet>(this.collectionName);

    // Create index on telegramId for fast lookups
    await this._collection.createIndex({ telegramId: 1 }, { unique: true });
    return this._collection;
  }

  async get(telegramId: string): Promise<StoredWallet | null> {
    const col = await this.collection();
    const wallet = await col.findOne({ telegramId });
    return wallet || null;
  }

  async set(telegramId: string, wallet: StoredWallet): Promise<void> {
    const col = await this.collection();
    await col.updateOne(
      { telegramId },
      { $set: wallet },
      { upsert: true },
    );
  }

  async insertIfAbsent(telegramId: string, wallet: StoredWallet): Promise<StoredWallet> {
    const col = await this.collection();
    try {
      await col.insertOne(wallet);
      return wallet;
    } catch (err: any) {
      // E11000 duplicate key error → wallet already exists, return existing
      if (err.code === 11000) {
        const existing = await col.findOne({ telegramId });
        return existing!;
      }
      throw err;
    }
  }

  async exists(telegramId: string): Promise<boolean> {
    const col = await this.collection();
    const count = await col.countDocuments({ telegramId }, { limit: 1 });
    return count > 0;
  }

  async delete(telegramId: string): Promise<void> {
    const col = await this.collection();
    await col.deleteOne({ telegramId });
  }
}

/**
 * Close MongoDB connection (for graceful shutdown)
 */
export async function closeMongoConnection(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    console.log('MongoDB connection closed');
  }
}
