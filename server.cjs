const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const Bonjour = require('bonjour');

const app = express();

let currentEsp32Ip = '172.20.10.5';
let esp32 = null;

function updateEsp32Client(ip) {
  if (!ip) return;
  currentEsp32Ip = ip;
  esp32 = axios.create({
    baseURL: `http://${ip}`,
    timeout: 5000,
    validateStatus: status => status < 500,
  });
  console.log(`[PROXY] Active hardware node targeted at: http://${ip}`);
}

// Target default ESP32 IP on startup
updateEsp32Client('172.20.10.5');

let bonjour = null;
function discoverEsp32() {
  if (bonjour) bonjour.destroy();
  bonjour = new Bonjour();
  const browser = bonjour.find({ type: 'http', protocol: 'tcp' });
  browser.on('up', (service) => {
    if (service.host === 'robocam.local' || service.name.toLowerCase().includes('robocam')) {
      const ipv4 = service.addresses.find(addr => addr.includes('.'));
      if (ipv4 && ipv4 !== currentEsp32Ip) {
        console.log(`[DISCOVER] Network node discovered via mDNS at ${ipv4}`);
        updateEsp32Client(ipv4);
      }
    }
  });
  setTimeout(() => {
    if (bonjour) {
      browser.stop();
      bonjour.destroy();
      bonjour = null;
    }
  }, 5000);
}
discoverEsp32();
setInterval(discoverEsp32, 30000);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  console.log(`➡ ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'RoboCam Proxy Active', esp32: currentEsp32Ip || 'searching...' });
});

const forwardToEsp32 = async (req, res, targetPath) => {
  if (!esp32) {
    return res.status(503).json({ ok: false, error: 'ESP32 target connection not initialized' });
  }
  try {
    let pathStr = targetPath;
    if (!pathStr) {
      pathStr = req.path.replace(/^\/api\/esp32/, '').replace(/^\/api/, '');
    }
    if (!pathStr.startsWith('/')) pathStr = '/' + pathStr;

    let response;
    try {
      response = await esp32({
        method: req.method,
        url: pathStr,
        params: req.query,
        data: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
      });
    } catch (err) {
      if (req.method !== 'GET') {
        console.log(`[PROXY] Initial ${req.method} failed (${err.message}), retrying as GET for http://${currentEsp32Ip}${pathStr}`);
        response = await esp32({
          method: 'GET',
          url: pathStr,
          params: req.query,
        });
      } else {
        throw err;
      }
    }

    if (response && response.status === 404 && req.method !== 'GET') {
      console.log(`[PROXY] Retrying POST 404 as GET for http://${currentEsp32Ip}${pathStr}`);
      try {
        response = await esp32({
          method: 'GET',
          url: pathStr,
          params: req.query,
        });
      } catch (retryErr) {
        // keep original response
      }
    }

    return res.status(response.status).send(response.data);
  } catch (error) {
    console.error(`[PROXY] Communication failure ${req.method} ${req.originalUrl}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Target connection unreachable', details: error.message });
  }
};

app.get('/api/discover', async (req, res) => {
  if (!esp32) {
    return res.status(503).json({ ok: false, error: 'Hardware node scanning in progress' });
  }
  try {
    const response = await esp32.get('/ping', { timeout: 3000 });
    if (response.status === 200 && response.data) {
      return res.json({ ok: true, esp32: currentEsp32Ip, data: response.data });
    }
    return res.status(502).json({ ok: false, error: 'ESP32 ping returned non-200 status' });
  } catch (err) {
    return res.status(503).json({ ok: false, error: 'ESP32 node unreachable', details: err.message });
  }
});

app.get('/api/wifi-list', (req, res) => forwardToEsp32(req, res, '/scan-wifi'));
app.post('/api/wifi-connect', (req, res) => forwardToEsp32(req, res, '/connect-wifi'));

// Generic catch-all proxy for /api/esp32
app.use('/api/esp32', (req, res) => forwardToEsp32(req, res));

// Direct proxy routes for required endpoints
app.all('/api/ping', (req, res) => forwardToEsp32(req, res, '/ping'));
app.all('/api/status', (req, res) => forwardToEsp32(req, res, '/status'));
app.all('/api/left', (req, res) => forwardToEsp32(req, res, '/left'));
app.all('/api/right', (req, res) => forwardToEsp32(req, res, '/right'));
app.all('/api/start', (req, res) => forwardToEsp32(req, res, '/start'));
app.all('/api/stop', (req, res) => forwardToEsp32(req, res, '/stop'));
app.all('/api/reset', (req, res) => forwardToEsp32(req, res, '/reset'));
app.all('/api/set-start', (req, res) => forwardToEsp32(req, res, '/set-start'));
app.all('/api/set-end', (req, res) => forwardToEsp32(req, res, '/set-end'));

app.post('/api/set-esp32-ip', (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: 'Invalid IP address format provided' });
  updateEsp32Client(ip);
  res.json({ ok: true, ip });
});

// ==========================================
// AI Control Python Process Orchestration
// ==========================================
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

let aiProcess = null;
let aiLogs = [];
let aiError = null;
let sseClients = [];

function checkStreamPort() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(5000, '127.0.0.1');
  });
}

// Enumerate available cameras by running main.py --enumerate
app.get('/api/ai/cameras', (req, res) => {
  let pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const venvPython = process.platform === 'win32'
    ? path.join(__dirname, 'OpenCvRobocam', 'venv', 'Scripts', 'python.exe')
    : path.join(__dirname, 'OpenCvRobocam', 'venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    pythonCmd = venvPython;
  }
  const scriptPath = path.join(__dirname, 'OpenCvRobocam', 'main.py');
  const cwd = path.join(__dirname, 'OpenCvRobocam');

  const proc = spawn(pythonCmd, ['-u', scriptPath, '--enumerate'], { cwd, stdio: 'pipe' });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('close', (code) => {
    try {
      // Find the JSON line in stdout (skip any warnings/logs)
      const lines = stdout.trim().split('\n');
      const jsonLine = lines.find(l => l.trim().startsWith('{'));
      if (jsonLine) {
        const data = JSON.parse(jsonLine.trim());
        return res.json(data);
      }
      res.json({ cameras: [] });
    } catch (e) {
      console.error('[AI] Camera enumeration parse error:', e.message, 'stdout:', stdout);
      res.json({ cameras: [] });
    }
  });
  proc.on('error', (err) => {
    console.error('[AI] Camera enumeration failed:', err.message);
    res.json({ cameras: [] });
  });
  // Timeout after 10 seconds
  setTimeout(() => {
    try { proc.kill(); } catch (e) { }
  }, 10000);
});

// Client frame upload endpoint – mobile browsers send camera frames here
const clientFramePath = path.join(__dirname, 'OpenCvRobocam', 'latest_client_frame.jpg');

app.post('/api/ai/upload-frame', (req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        fs.writeFileSync(clientFramePath, buffer);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[AI] Frame upload error:', err.message);
      res.status(500).json({ ok: false });
    }
  });
});

app.post('/api/ai/start', (req, res) => {
  if (aiProcess) {
    return res.json({ ok: true, message: 'AI Control already active' });
  }

  aiLogs = [];
  aiError = null;

  const esp32Ip = currentEsp32Ip || req.body.ip || '';
  const cameraSource = req.body.source || 'client';  // default to 'client' (browser camera stream)
  const cameraType = req.body.camera || 'front';
  const effectiveCamera = cameraSource === 'client' ? 'client' : cameraType;
  console.log(`[AI] Starting OpenCV RoboCam module with ESP32 IP: ${esp32Ip}, Camera: ${effectiveCamera} (source: ${cameraSource})`);

  // Clean up any stale client frame file
  if (cameraSource === 'client') {
    try { fs.unlinkSync(clientFramePath); } catch (e) { }
  }

  let pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const venvPython = process.platform === 'win32'
    ? path.join(__dirname, 'OpenCvRobocam', 'venv', 'Scripts', 'python.exe')
    : path.join(__dirname, 'OpenCvRobocam', 'venv', 'bin', 'python');

  if (fs.existsSync(venvPython)) {
    pythonCmd = venvPython;
  }

  const scriptPath = path.join(__dirname, 'OpenCvRobocam', 'main.py');
  const cwd = path.join(__dirname, 'OpenCvRobocam');

  const args = ['-u', scriptPath];
  if (esp32Ip) {
    args.push('--ip', esp32Ip);
  }
  args.push('--camera', effectiveCamera);

  const spawnedProcess = spawn(pythonCmd, args, {
    cwd: cwd,
    stdio: 'pipe',
    env: { ...process.env }
  });

  aiProcess = spawnedProcess;

  let stdoutBuffer = '';
  spawnedProcess.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(text);
    aiLogs.push(text);
    if (aiLogs.length > 200) aiLogs.shift();

    stdoutBuffer += text;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.substring(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);

      if (line === 'MOVED LEFT' || line === 'MOVED RIGHT') {
        sseClients.forEach(client => {
          try {
            client.write(`data: ${JSON.stringify({ event: 'move', direction: line })}\n\n`);
          } catch (e) {
            console.error('[AI] Failed to send SSE event:', e.message);
          }
        });
      }
    }
  });

  spawnedProcess.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(text);
    aiLogs.push(text);
    if (aiLogs.length > 200) aiLogs.shift();
  });

  spawnedProcess.on('close', (code) => {
    console.log(`[AI] Python process exited with code ${code}`);
    if (code !== 0 && code !== null) {
      const logText = aiLogs.join('');
      const lines = logText.split('\n').map(l => l.trim()).filter(Boolean);
      let errorSummary = '';

      const tracebackIndex = lines.findIndex(l => l.startsWith('Traceback '));
      if (tracebackIndex !== -1) {
        errorSummary = lines.slice(tracebackIndex).join('\n');
      } else {
        const errorLines = lines.filter(l => l.includes('Error') || l.includes('Exception') || l.includes('[FATAL]') || l.includes('failed'));
        if (errorLines.length > 0) {
          errorSummary = errorLines.slice(-3).join('\n');
        } else {
          errorSummary = lines.slice(-5).join('\n');
        }
      }
      aiError = errorSummary || `Process exited with code ${code}`;
    }
    if (aiProcess === spawnedProcess) {
      aiProcess = null;
    }
  });

  spawnedProcess.on('error', (err) => {
    console.error('[AI] Failed to start Python process:', err);
    aiError = `Failed to start Python process: ${err.message}`;
    if (aiProcess === spawnedProcess) {
      aiProcess = null;
    }
  });

  res.json({ ok: true });
});

app.post('/api/ai/stop', (req, res) => {
  if (aiProcess) {
    console.log('[AI] Stopping OpenCV process...');
    aiProcess.kill();
    aiProcess = null;
    res.json({ ok: true });
  } else {
    res.json({ ok: true, message: 'AI Control not running' });
  }
});

app.post('/api/ai/reset', (req, res) => {
  if (aiProcess && !aiProcess.killed) {
    console.log('[AI] Sending reset command to Python process...');
    aiProcess.stdin.write('r\n');
    res.json({ ok: true });
  } else {
    res.status(400).json({ ok: false, error: 'AI process is not running' });
  }
});

app.get('/api/ai/status', async (req, res) => {
  const running = aiProcess !== null;
  let streamActive = false;
  if (running) {
    streamActive = await checkStreamPort();
  }
  res.json({ running, streamActive, error: aiError });
});

app.get('/api/ai/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});


// Proxy route for the Python OpenCV MJPEG live stream
app.get('/api/ai/stream', (req, res) => {
  const options = {
    host: '127.0.0.1',
    port: 5000,
    path: '/stream',
    method: 'GET'
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    headers['cross-origin-resource-policy'] = 'cross-origin';
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[STREAM] MJPEG Proxy request failure:', err.message);
    if (!res.headersSent) {
      res.status(503).send('Stream unavailable');
    }
  });

  req.on('close', () => {
    proxyReq.destroy();
  });

  proxyReq.end();
});

// ==========================================
// AI Control Recordings API
// ==========================================
app.get('/api/ai-recordings', (req, res) => {
  const recordingsDir = path.join(__dirname, 'OpenCvRobocam', 'recordings');
  if (!fs.existsSync(recordingsDir)) {
    return res.json([]);
  }

  fs.readdir(recordingsDir, (err, files) => {
    if (err) {
      console.error('[AI recordings] Read error:', err);
      return res.status(500).json({ error: 'Failed to read recordings directory' });
    }

    const mp4Files = files.filter(f => f.endsWith('.mp4'));
    const list = mp4Files.map(file => {
      const filePath = path.join(recordingsDir, file);
      const stats = fs.statSync(filePath);

      const jsonPath = filePath.replace('.mp4', '.json');
      let metadata = {};
      if (fs.existsSync(jsonPath)) {
        try {
          metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (e) {
          console.error('[AI recordings] Metadata parse error:', e);
        }
      }

      return {
        id: `ai-${file}`,
        name: file,
        duration: metadata.duration || 0,
        createdAt: metadata.createdAt || stats.mtimeMs,
        size: stats.size,
        mode: 'AI Control',
        ext: 'mp4',
        mimeType: 'video/mp4'
      };
    });

    list.sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
  });
});

app.get('/api/ai-recordings/file/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).send('Invalid filename');
  }

  const filePath = path.join(__dirname, 'OpenCvRobocam', 'recordings', filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  res.sendFile(filePath);
});

app.delete('/api/ai-recordings/file/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).send('Invalid filename');
  }

  const filePath = path.join(__dirname, 'OpenCvRobocam', 'recordings', filename);
  const jsonPath = filePath.replace('.mp4', '.json');

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[AI recordings] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Process Cleanup Handler
const cleanupAiProcess = () => {
  if (aiProcess) {
    console.log('[AI] Cleaning up dangling OpenCV process...');
    aiProcess.kill();
    aiProcess = null;
  }
};
process.on('exit', cleanupAiProcess);
process.on('SIGINT', () => { cleanupAiProcess(); process.exit(); });
process.on('SIGTERM', () => { cleanupAiProcess(); process.exit(); });

app.use((err, req, res, next) => {
  console.error('[SERVER] Critical exception intercept:', err);
  res.status(500).json({ ok: false, error: 'Internal Server Exception' });
});

try {
  const keyPath = fs.existsSync('./cert-key.pem') ? './cert-key.pem' : './192.168.29.48-key.pem';
  const certPath = fs.existsSync('./cert.pem') ? './cert.pem' : './192.168.29.48.pem';
  const tlsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  https.createServer(tlsOptions, app).listen(3000, '0.0.0.0', () => {
    console.log('🔒 Secure TLS listening on Port 3000');
  });
} catch (e) {
  console.warn('⚠️ Development warning: Local TLS certificates skipped:', e.message);
}

http.createServer(app).listen(3001, '0.0.0.0', () => {
  console.log('🌐 Local HTTP runtime listening on Port 3001');
});