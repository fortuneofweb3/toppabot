interface PayBillParams {
  type: 'electricity' | 'airtime' | 'data' | 'cable';
  provider: string;
  amount: number;
  accountNumber: string;
}

/**
 * Pay bills via VTU.ng API
 */
export async function payBill(params: PayBillParams) {
  const { type, provider, amount, accountNumber } = params;

  try {
    // TODO: Implement actual VTU.ng API
    // Mock response for now

    return {
      success: true,
      type,
      provider,
      amount,
      accountNumber,
      transactionId: 'VTU-' + Date.now(),
      status: 'success',
      message: `${type} payment of ₦${amount} to ${provider} successful`,
    };
  } catch (error) {
    throw new Error(`Bill payment failed: ${error.message}`);
  }
}
