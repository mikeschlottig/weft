export function total(items) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return subtotal;
}
