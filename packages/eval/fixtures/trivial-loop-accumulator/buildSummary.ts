interface OrderItem {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly discount: number;
}

interface OrderSummary {
  readonly subtotal: number;
  readonly totalDiscount: number;
  readonly itemCount: number;
  readonly lineItems: number;
}

export function buildOrderSummary(items: readonly OrderItem[]): OrderSummary {
  let subtotal = 0;
  let totalDiscount = 0;
  let itemCount = 0;

  for (const item of items) {
    subtotal += item.quantity * item.unitPrice;
    totalDiscount += item.discount * item.quantity;
    itemCount += item.quantity;
  }

  return {
    subtotal,
    totalDiscount,
    itemCount,
    lineItems: items.length,
  };
}
