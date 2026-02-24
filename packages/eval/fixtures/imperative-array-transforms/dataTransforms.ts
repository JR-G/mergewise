interface Order { id: string; total: number; status: "pending" | "shipped" | "delivered" }

function getShippedOrderIds(orders: Order[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < orders.length; i++) {
    if (orders[i].status === "shipped") {
      result.push(orders[i].id);
    }
  }
  return result;
}

function calculateRevenue(orders: Order[]): number {
  let revenue = 0;
  for (const order of orders) {
    if (order.status === "delivered") {
      revenue += order.total;
    }
  }
  return revenue;
}

function buildSummary(orders: Order[]): string {
  let summary = "";
  for (const order of orders) {
    summary += `${order.id}: ${order.status}\n`;
  }
  return summary;
}
