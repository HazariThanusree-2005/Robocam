# 📷 RoboCam — Smart Robotic Camera System

A modern mobile-first web app for controlling an ESP32-powered camera slider with timelapse recording.

## 🚀 Quick Start (Windows)

### Prerequisites
- Node.js 20 LTS (https://nodejs.org)
- npm (comes with Node.js)

### Install & Run

```cmd
cd robocam
npm install
npm run dev
```

The app will start at: **http://localhost:5173**

### Access from your phone

Make sure your PC and phone are on the **same WiFi network**, then open:

```
http://<YOUR-PC-IP>:5173
```

To find your PC's IP on Windows:
```cmd
ipconfig
```
Look for `IPv4 Address` under your WiFi adapter.

---

## 📱 Features

### 🏠 Home
- Connect to your ESP32 by tapping the status badge and entering its IP
- Navigate to all 4 main sections

### ⚙️ Motion Setup
- Open back camera and set Start & End positions visually
- Preview the motion path before recording
- Configure pause duration at endpoints (cinematic effect)
- Load from built-in presets (Study, Desk, Product, Cooking)
- Save and manage your own custom presets

### ⚡ Speed Control
- Choose from Slow / Medium / Fast presets
- Fine-tune motor delay with a slider (5–100ms)
- Lower delay = faster motor movement

### 🎥 Start Capture
- Opens back camera automatically
- Select timelapse speed (4×, 8×, 16×)
- Sends motion data to ESP32 via HTTP POST
- Records video and saves to IndexedDB
- Stop button stops recording and signals ESP32

### 🎬 My Shots
- Browse all saved recordings
- Play directly in browser
- Download as webm/mp4 file
- Delete recordings

---

## 🔌 ESP32 Integration

The app sends HTTP requests to your ESP32 over local WiFi.

### Expected Endpoints

**POST** `http://<ESP32-IP>/start`
```json
{
  "startAngle": -45,
  "endAngle": 45,
  "delay": 30,
  "pauseDuration": 2,
  "preset": "My Setup"
}
```

**POST** `http://<ESP32-IP>/stop`
```json
{}
```

**GET** `http://<ESP32-IP>/ping`  
_(returns any 200 OK to confirm connection)_

### CORS on ESP32

Add this to your ESP32 HTTP server responses:
```cpp
server.sendHeader("Access-Control-Allow-Origin", "*");
server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
```

---

## 📁 Project Structure

```
robocam/
├── public/
│   └── cam-icon.svg
├── src/
│   ├── components/
│   │   └── UI.jsx          # Reusable UI components
│   ├── context/
│   │   └── AppContext.jsx  # Global app state
│   ├── pages/
│   │   ├── HomePage.jsx
│   │   ├── MotionSetupPage.jsx
│   │   ├── SpeedControlPage.jsx
│   │   ├── CapturePage.jsx
│   │   └── MyShotsPage.jsx
│   ├── utils/
│   │   ├── db.js           # IndexedDB (recordings + presets)
│   │   └── esp32.js        # HTTP communication
│   ├── App.jsx
│   ├── main.jsx
│   └── index.css
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

---

## 🛠️ Build for Production

```cmd
npm run build
npm run preview
```

---

## ⚠️ Troubleshooting

**Camera not working on mobile?**
- Make sure you're accessing via `http://` (not `https://`) on local network
- Allow camera permissions in browser settings

**ESP32 not connecting?**
- Confirm both devices are on same WiFi
- Check ESP32 has CORS headers enabled
- Test the IP directly in browser: `http://<ESP32-IP>/ping`

**npm install fails?**
- Make sure you're using Node.js 20 LTS
- Run: `npm cache clean --force` then retry
