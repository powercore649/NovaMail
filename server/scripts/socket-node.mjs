import tls from 'node:tls';

export function connect(address, options = {}) {
  const socket = tls.connect({
    host: address.hostname,
    port: address.port,
    servername: address.hostname,
    rejectUnauthorized: true,
  });

  const readable = new ReadableStream({
    start(controller) {
      socket.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      socket.on('end', () => {
        try {
          controller.close();
        } catch {
          /* déjà fermé */
        }
      });
      socket.on('error', (error) => controller.error(error));
    },
    cancel() {
      socket.destroy();
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        socket.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()));
      });
    },
    close() {
      socket.end();
    },
  });

  return {
    readable,
    writable,
    close: async () => {
      socket.end();
    },
    startTls() {
      throw new Error('STARTTLS non pris en charge dans le test local.');
    },
  };
}
