import path from 'path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverProcess = null;
let serverPort = null;

/**
 * Ask the OS for a free ephemeral port.
 *
 * Picking a random port in a fixed range is not safe on Windows: Hyper-V/WSL
 * reserves blocks (e.g. 3389 for RDP) where listen() fails with EACCES, so a
 * random 3100-3999 draw intermittently kills the suite with
 * "Server failed to start ... after 30 attempts". Letting the kernel choose
 * avoids the whole class of collisions.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, maxRetries = 30, interval = 1000, isDead = () => false) {
  for (let i = 0; i < maxRetries; i++) {
    // The child can die before it ever listens (EACCES/EADDRINUSE). Detect that
    // immediately instead of burning the full 30s waiting for a corpse.
    if (isDead()) throw new Error(`Server exited before listening on port ${port}`);
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} attempts`);
}

async function startServer(port = 0, extraEnv = {}) {
  const usePort = port || await findFreePort();
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');

  const log = {
    info: (msg) => { if (cfg.serverEnv.DEBUG_SERVER) console.log(msg); },
    error: (msg) => { if (cfg.serverEnv.DEBUG_SERVER) console.error(msg); },
  };

  serverProcess = launchServer({
    pluginDir,
    port: usePort,
    env: { ...cfg.serverEnv, DEBUG_RESPONSES: 'false', ...extraEnv },
    log,
  });

  let dead = false;
  serverProcess.on('error', (err) => {
    dead = true;
    console.error('Failed to start server:', err);
  });
  serverProcess.on('exit', () => { dead = true; });

  serverPort = usePort;

  await waitForServer(usePort, 30, 1000, () => dead);

  console.log(`camofox-browser server started on port ${usePort}`);
  return usePort;
}

async function stopServer() {
  if (serverProcess) {
    return new Promise((resolve) => {
      serverProcess.on('close', () => {
        serverProcess = null;
        serverPort = null;
        resolve();
      });

      serverProcess.kill('SIGTERM');

      setTimeout(() => {
        if (serverProcess) {
          serverProcess.kill('SIGKILL');
        }
      }, 5000);
    });
  }
}

function getServerUrl() {
  if (!serverPort) throw new Error('Server not started');
  return `http://localhost:${serverPort}`;
}

function getServerPort() {
  return serverPort;
}

export {
  startServer,
  stopServer,
  getServerUrl,
  getServerPort
};
