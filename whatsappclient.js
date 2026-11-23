let whatsappClient;
// Resolvers waiting for the client to (re)connect
const waiters = new Set();

const setWhatsAppClient = (client) => {
  whatsappClient = client;
  if (client) {
    const pending = [...waiters];
    waiters.clear();
    pending.forEach((resolve) => resolve(client));
  }
};

const getWhatsAppClient = () => {
  // Debugging: Check if whatsappClient is undefined
  if (whatsappClient === undefined) {
    console.warn('WhatsApp client is undefined. Ensure it is initialized properly.');
  }
  return whatsappClient;
};

// Resolves with the connected client, or null if not connected within timeoutMs.
// Rides out short reconnects instead of failing the request immediately.
const waitForWhatsAppClient = (timeoutMs = 30000) => {
  if (whatsappClient) return Promise.resolve(whatsappClient);

  return new Promise((resolve) => {
    const done = (client) => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve(client);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    waiters.add(done);
  });
};

// Connection manager (index.js) registers a probe that pings WhatsApp and
// forces a reconnect if the socket is dead
let healthCheck = null;
const setHealthCheck = (fn) => {
  healthCheck = fn;
};

// Resolves true if the socket answered a ping, false if it was dead (reconnect started)
const requestHealthCheck = () => (healthCheck ? healthCheck() : Promise.resolve(false));

module.exports = {
  setWhatsAppClient,
  whatsappClient,
  getWhatsAppClient,
  waitForWhatsAppClient,
  setHealthCheck,
  requestHealthCheck,
};
