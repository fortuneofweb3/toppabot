/**
 * Pending Order Store — Tracks orders awaiting user confirmation
 *
 * Orders go through: pending_confirmation → pending_payment → processing → completed/failed
 * Auto-expires after 10 minutes. One active order per user.
 */

export interface PendingOrder {
  orderId: string;
  telegramId: string;
  chatId: number;
  messageId?: number;

  // Order details (from AI agent)
  action: 'airtime' | 'data' | 'bill' | 'gift_card';
  description: string;
  productAmount: number;
  serviceFee: number;
  totalAmount: number;

  // Tool call details (to replay after confirmation)
  toolName: string;
  toolArgs: Record<string, any>;

  // State
  status: 'pending_confirmation' | 'pending_payment' | 'processing' | 'completed' | 'cancelled' | 'failed';
  createdAt: number;
  expiresAt: number;

  // Result
  txHash?: string;
  result?: any;
  error?: string;
}

const ORDER_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export class PendingOrderStore {
  private orders = new Map<string, PendingOrder>();
  private userOrders = new Map<string, string>(); // telegramId → current orderId

  create(order: PendingOrder): void {
    // Cancel any existing order for this user
    const existingId = this.userOrders.get(order.telegramId);
    if (existingId) {
      this.orders.delete(existingId);
    }
    this.orders.set(order.orderId, order);
    this.userOrders.set(order.telegramId, order.orderId);
  }

  get(orderId: string): PendingOrder | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (Date.now() > order.expiresAt) {
      this.remove(orderId);
      return null;
    }
    return order;
  }

  getByUser(telegramId: string): PendingOrder | null {
    const orderId = this.userOrders.get(telegramId);
    if (!orderId) return null;
    return this.get(orderId);
  }

  updateStatus(orderId: string, status: PendingOrder['status'], extra?: Partial<PendingOrder>): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = status;
      if (extra) Object.assign(order, extra);
    }
  }

  remove(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      this.userOrders.delete(order.telegramId);
      this.orders.delete(orderId);
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, order] of this.orders) {
      if (now > order.expiresAt) {
        this.userOrders.delete(order.telegramId);
        this.orders.delete(id);
      }
    }
  }
}

/**
 * Generate a short unique order ID
 */
export function generateOrderId(): string {
  return `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
