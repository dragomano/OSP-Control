import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = Number('__PORT__');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(__NODE_READY_JSON__ + '\n');
});
server.listen(port, host, () => console.log(__NODE_LISTENING_JSON__.replace('{url}', `http://${host}:${port}`)));
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
