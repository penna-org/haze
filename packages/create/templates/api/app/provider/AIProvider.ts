import { aiProvider } from '@hazejs/ai'

// AI：读取 config/ai.ts 注册各厂商，之后可用字符串（厂商:模型 / 别名）引用模型
export default aiProvider()
