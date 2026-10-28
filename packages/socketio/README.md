# @hazejs/socket.io

Socket.IO server integration for hazejs: namespaces from `app/socket/*.ts`, guard-based handshake auth, Redis adapter, Node and Bun.

## Install

```bash
pnpm add @hazejs/socket.io socket.io
```

## Usage

```ts
// app/socket/chat.ts
export default defineNamespace({
  middleware: [
    authenticate()
  ],
  connection(socket, io) {
    socket.on('chat:send', text => io.of('/chat').emit('chat:message', text))
  },
})
```

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
