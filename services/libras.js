/* The provider API is not active until its URL, key, and request/response contract are configured server-side. */
export const LibrasAdapter = {
  get ready() { return false; },
  async request() {
    throw new Error('A integração de Libras está preparada, mas ainda desativada. Configure o provedor no backend antes de usá-la.');
  },
};
