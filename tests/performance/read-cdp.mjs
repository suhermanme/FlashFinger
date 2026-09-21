const port = process.argv[2];
const targetUrl = process.argv[3];
const label = process.argv[4] ?? 'RUNTIME_PERFORMANCE_BASELINE';
if (!port || !targetUrl) throw new Error('Usage: read-cdp.mjs <port> <url> [label]');

const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
if (!created.ok) throw new Error(`DevTools target creation failed: ${created.status}`);
const target = await created.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  const handlers = pending.get(message.id);
  if (!handlers) return;
  pending.delete(message.id);
  if (message.error) handlers.reject(new Error(message.error.message));
  else handlers.resolve(message.result);
});

function call(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const deadline = Date.now() + 30_000;
let value = 'pending';
while (Date.now() < deadline && value === 'pending') {
  const response = await call('Runtime.evaluate', {
    expression: "document.querySelector('#result')?.textContent ?? 'pending'",
    returnByValue: true,
  });
  value = response.result?.value ?? 'pending';
  if (value === 'pending') await new Promise((resolve) => setTimeout(resolve, 50));
}
socket.close();
if (value === 'pending') throw new Error('Performance harness timed out');
process.stdout.write(`${label} ${value}\n`);
