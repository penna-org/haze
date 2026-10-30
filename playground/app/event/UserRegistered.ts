import { defineEvent } from '@hazejs/core'

export default defineEvent<{ name: string }>({ name: 'UserRegistered' })
