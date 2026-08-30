function getApiBase() {
  return '/api/esp32';
}

export function setESP32IP(ip) {
  localStorage.setItem('esp32_ip', ip);
  fetch('/api/set-esp32-ip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip }),
  }).catch(() => { });
}

export function getESP32IP() {
  return localStorage.getItem('esp32_ip') || '172.20.10.5';
}

// ===== START MOTION =====
export async function sendStartCommand(motionData) {
  const response = await fetch(`${getApiBase()}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(motionData || {}),
  });
  if (!response.ok) throw new Error(`Server returned exception flag: ${response.status}`);
  return await response.json().catch(() => ({ ok: true }));
}

// ===== STOP MOTION =====
export async function sendStopCommand() {
  try {
    const response = await fetch(`${getApiBase()}/stop`, { method: 'POST' });
    return response.ok;
  } catch (err) {
    console.error('Stop command failure:', err);
    return false;
  }
}

// ===== PING ESP32 =====
export async function pingESP32() {
  try {
    const response = await fetch(`${getApiBase()}/ping`);
    if (response.ok) {
      const data = await response.json();
      return data && (data.ok === true || data.status === 'connected');
    }
    return false;
  } catch (err) {
    console.error('Network handshake failure:', err);
    return false;
  }
}