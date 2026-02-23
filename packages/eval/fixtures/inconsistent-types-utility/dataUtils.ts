interface UserProfile {
  name: string;
  email: string | null;
  phone?: string;
  address: string | undefined;
}

function merge<T extends object>(a: T, b: T): T {
  return { ...a, ...b };
}

function fetchAndProcess(id: string) {
  fetchUser(id, (user) => {
    fetchOrders(user.id, (orders) => {
      fetchItems(orders[0].id, (items) => {
        processAll(user, orders, items);
      });
    });
  });
}
