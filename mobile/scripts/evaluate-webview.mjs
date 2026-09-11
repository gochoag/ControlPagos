const expression = process.argv.slice(2).join(' ');
if (!expression) throw new Error('Indica una expresión JavaScript');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
if (!targets.length) throw new Error('No hay un WebView conectado al puerto 9222');

const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

const result = await new Promise((resolve, reject) => {
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result.result);
  };
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }));
});

socket.close();
console.log(JSON.stringify(result));
