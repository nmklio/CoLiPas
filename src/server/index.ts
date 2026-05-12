import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { attachSshShellSocketServer } from './sshShellSocket.js';

const config = loadConfig();
const app = createApp(config);
const server = http.createServer(app);
attachSshShellSocketServer(server, config);

server.listen(config.port, () => {
  console.log(`CoLiPas API listening on port ${config.port}`);
});
