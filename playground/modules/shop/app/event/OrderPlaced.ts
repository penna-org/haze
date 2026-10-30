export default defineEvent<{ orderId: number, total: number }>({ name: 'OrderPlaced' })
