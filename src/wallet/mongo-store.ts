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

async function getDb(): Promise<Db> {
  if (_db) return _db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not configured');

  _client = new MongoClient(uri);
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
