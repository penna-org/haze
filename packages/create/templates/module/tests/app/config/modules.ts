import { defineModulesConfig } from '@hazejs/core'
import posts from '../../../src'

export default defineModulesConfig({
  modules: [
    posts({ perPage: 2 }),
  ],
})
