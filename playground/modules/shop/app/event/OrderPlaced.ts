import { defineEvent } from '@hazejs/core'

export default defineEvent<{ orderId: number, total: number }>({ name: 'OrderPlaced' })
