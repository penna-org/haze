export default {
  name: 'UserRegistered',
  emit: (payload: { name: string }) => `registered ${payload.name}`,
}
