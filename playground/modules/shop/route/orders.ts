let nextId = 1

export default defineRoutes((r) => {
  r.get('/orders', () => []).name('orders.index')

  r.post('/orders', async () => {
    const order = { orderId: nextId++, total: 42 }
    await OrderPlaced.emit(order)
    await SendReceipt.dispatch({ orderId: order.orderId })
    return order
  }).name('orders.store')
})
