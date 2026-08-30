#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <esp_wifi.h>

// ========== Access Point credentials ==========
const char* ap_ssid = "RoboCam_Setup";
const char* ap_password = NULL;        // Open, unencrypted configuration network
const int ap_channel = 6;              // Clean channel for fast mobile adapter detection

// ========== Servo configuration ==========
Servo myServo;
WebServer server(80);
Preferences preferences;

// ========== State Tracking Flags ==========
bool isApModeActive = false;

// ========== Embedded Lightweight HTML Provisioning Portal UI ==========
// Hosted completely inside ESP32 program flash memory to bypass Vercel HTTPS mixed-content blocks
const char PROVISION_UI[] PROGMEM = R"rawhtml(
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RoboCam Wi-Fi Setup</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0c; color: #f3f4f6; margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; box-sizing: border-box; }
        .card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 20px; padding: 25px; width: 100%; max-width: 400px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); backdrop-filter: blur(10px); }
        h2 { margin-top: 0; color: #3b82f6; font-size: 24px; font-weight: 700; tracking-letter: -0.5px; }
        p { color: rgba(255,255,255,0.6); font-size: 14px; line-height: 1.5; }
        label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; tracking-letter: 0.5px; color: rgba(255,255,255,0.4); }
        select, input[type="password"], input[type="text"] { width: 100%; padding: 12px; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; color: #fff; font-size: 15px; margin-bottom: 20px; box-sizing: border-box; outline: none; transition: border 0.2s; }
        select:focus, input:focus { border-color: #3b82f6; }
        select option { background: #141416; color: #fff; }
        .btn { width: 100%; padding: 14px; background: #3b82f6; border: none; border-radius: 12px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s, transform 0.1s; }
        .btn:active { background: #2563eb; transform: scale(0.98); }
        .btn:disabled { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.3); cursor: not-allowed; }
        .status { font-size: 13px; padding: 10px; border-radius: 8px; margin-bottom: 15px; display: none; }
        .info-msg { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); color: #93c5fd; display: block; }
        .success-msg { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.2); color: #4ade80; }
        .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 0.8s linear infinite; margin-right: 8px; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="card" id="setupCard">
        <h2>RoboCam Setup</h2>
        <p>Connect your camera hardware tracking module directly to your local home network wave channels.</p>
        
        <div id="statusBox" class="status info-msg"><span class="spinner"></span>Scanning for networks...</div>

        <form id="wifiForm" onsubmit="submitCredentials(event)">
            <label for="ssid">Select Network</label>
            <select id="ssid" onchange="toggleManualInput()" disabled>
                <option value="">-- Choose network --</option>
            </select>

            <div id="manualSsidContainer" style="display:none;">
                <label for="manualSsid">Network Name (SSID)</label>
                <input type="text" id="manualSsid" placeholder="Enter custom Wi-Fi name">
            </div>

            <label for="password">Wi-Fi Password</label>
            <input type="password" id="password" placeholder="Enter network password" required>

            <button type="submit" id="submitBtn" class="btn" disabled>Save & Connect</button>
        </form>
    </div>

    <script>
        window.addEventListener('DOMContentLoaded', () => {
            fetch('/scan')
                .then(res => res.json())
                .then(data => {
                    const select = document.getElementById('ssid');
                    const statusBox = document.getElementById('statusBox');
                    
                    Object.keys(data).forEach(network => {
                        if(network.trim() !== "") {
                            const opt = document.createElement('option');
                            opt.value = network;
                            opt.innerText = network;
                            select.appendChild(opt);
                        }
                    });

                    const manualOpt = document.createElement('option');
                    manualOpt.value = "__MANUAL__";
                    manualOpt.innerText = "[ Enter Hidden/Custom SSID ]";
                    select.appendChild(manualOpt);

                    select.disabled = false;
                    document.getElementById('submitBtn').disabled = false;
                    statusBox.style.display = 'none';
                })
                .catch(err => {
                    const statusBox = document.getElementById('statusBox');
                    statusBox.innerText = "❌ Scan failed. Refresh page to try again.";
                    statusBox.className = "status";
                    statusBox.style.color = "#f87171";
                    statusBox.style.background = "rgba(239, 68, 68, 0.1)";
                    statusBox.style.border = "1px solid rgba(239, 68, 68, 0.2)";
                });
        });

        function toggleManualInput() {
            const select = document.getElementById('ssid');
            const container = document.getElementById('manualSsidContainer');
            if (select.value === "__MANUAL__") {
                container.style.display = "block";
                document.getElementById('manualSsid').required = true;
            } else {
                container.style.display = "none";
                document.getElementById('manualSsid').required = false;
            }
        }

        function submitCredentials(e) {
            e.preventDefault();
            const select = document.getElementById('ssid');
            const password = document.getElementById('password').value;
            const statusBox = document.getElementById('statusBox');
            const submitBtn = document.getElementById('submitBtn');

            let ssid = select.value;
            if (ssid === "__MANUAL__") {
                ssid = document.getElementById('manualSsid').value;
            }

            if (!ssid) {
                alert("Please select or enter a valid Wi-Fi network");
                return;
            }

            submitBtn.disabled = true;
            statusBox.innerHTML = '<span class="spinner"></span>Saving credentials to RoboCam memory...';
            statusBox.className = "status info-msg";
            statusBox.style.display = "block";

            fetch('/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `ssid=${encodeURIComponent(ssid)}&password=${encodeURIComponent(password)}`
            })
            .then(res => res.json())
            .then(data => {
                document.getElementById('wifiForm').style.display = 'none';
                document.getElementById('setupCard').innerHTML = `
                    <h2>✅ Credentials Saved!</h2>
                    <p style="color: #4ade80; font-weight: 600;">RoboCam is migrating network configurations directly onto your router subnet space.</p>
                    <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 20px 0;">
                    <p>1. Disconnect from <b>RoboCam_Setup</b>.<br>2. Log your phone back into your home Wi-Fi network.<br>3. Open your deployed dashboard link to manage the hardware controls: </p>
                    <a href="https://robocam.vercel.app" style="display: block; text-align: center; padding: 14px; background: #22c55e; color: #fff; text-decoration: none; font-weight: 600; border-radius: 12px; margin-top: 15px;">Open RoboCam Control Center</a>
                `;
            })
            .catch(err => {
                submitBtn.disabled = false;
                statusBox.innerText = "❌ Failed to submit configuration parameters. Retry.";
                statusBox.style.color = "#f87171";
            });
        }
    </script>
</body>
</html>
)rawhtml";

// ========== Helper Modules ==========
void sendJson(int code, const String& json) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(code, "application/json", json);
}

// ========== WiFi Diagnostics Monitor Events ==========
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
      Serial.println("[WIFI ENGINE] Interface initialization complete.");
      break;
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("[WIFI ENGINE] Handshake structural link verified. Requesting IP address assignment...");
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.print("[WIFI ENGINE] Valid dynamic network address bound: ");
      Serial.println(WiFi.localIP());
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.print("[WIFI ENGINE] Disconnected from station. Native reason code tracking code: ");
      Serial.println(info.wifi_sta_disconnected.reason);
      break;
    default:
      break;
  }
}

// ========== HTTP Core Core Portal Routing Mappings ==========
void handlePortalRoot() {
  Serial.println("[HTTP Portal Server] Serving embedded UI configuration page down to client browser...");
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send_P(200, "text/html", PROVISION_UI);
}

void handlePing() { 
  Serial.println("[HTTP Server] Hit received on: GET /ping");
  sendJson(200, "{\"status\":\"connected\",\"ok\":true,\"ip\":\"" + WiFi.localIP().toString() + "\"}"); 
}

void handleStatus() { 
  Serial.println("[HTTP Server] Hit received on: GET /status");
  if (isApModeActive) {
    sendJson(200, "{\"ok\":true,\"mode\":\"provisioning\"}"); 
  } else {
    sendJson(200, "{\"ok\":true,\"mode\":\"station\"}"); 
  }
}

void handleScan() {
  Serial.println("[HTTP Portal Server] Asynchronous scan triggered via local AJAX call...");
  int n = WiFi.scanNetworks();
  
  String resp = "{";
  for (int i = 0; i < n; i++) {
    resp += "\"" + WiFi.SSID(i) + "\":0";
    if (i < n - 1) resp += ",";
  }
  resp += "}";
  WiFi.scanDelete();
  sendJson(200, resp);
}

void handleConnect() {
  Serial.println("[HTTP Portal Server] Asynchronous network write request payload received...");
  if (!server.hasArg("ssid") || !server.hasArg("password")) {
    sendJson(400, "{\"error\":\"Missing configuration fields\"}");
    return;
  }
  
  String ssid = server.arg("ssid");
  String pass = server.arg("password");
  
  ssid.trim();
  pass.trim();

  Serial.printf("[NVS Storage Write] Syncing credentials to system drive: %s\n", ssid.c_str());
  
  preferences.begin("robocam", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.end();
  
  sendJson(200, "{\"ok\":true,\"message\":\"Local memory write transaction complete. Hard system reboot scheduled.\"}");
  delay(2000);
  ESP.restart();
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

// ========== Motor API Endpoints ==========
void moveRight() {
  myServo.write(180);      // Rotate Clockwise
  delay(5000);
  myServo.write(90);       // Stop
  Serial.println("Rotated Right");
  sendJson(200, "{\"ok\":true}");
}

void moveLeft() {
  myServo.write(0);        // Rotate Anti-clockwise
  delay(5000);
  myServo.write(90);       // Stop
  Serial.println("Rotated Left");
  sendJson(200, "{\"ok\":true}");
}

void handleStart() { sendJson(200, "{\"ok\":true}"); }
void handleStop()  { sendJson(200, "{\"ok\":true}"); }

void registerServerRoutes() {
  server.on("/",        HTTP_GET,     handlePortalRoot); // Serves the self-contained raw UI directly
  server.on("/ping",    HTTP_GET,     handlePing);
  server.on("/status",  HTTP_GET,     handleStatus);
  server.on("/scan",    HTTP_GET,     handleScan);
  server.on("/connect", HTTP_POST,    handleConnect);
  server.on("/right",   HTTP_GET,     moveRight);
  server.on("/left",    HTTP_GET,     moveLeft);
  server.on("/start",   HTTP_POST,    handleStart);
  server.on("/stop",    HTTP_POST,    handleStop);
  
  server.on("/",        HTTP_OPTIONS, handleOptions);
  server.on("/ping",    HTTP_OPTIONS, handleOptions);
  server.on("/status",  HTTP_OPTIONS, handleOptions);
  server.on("/scan",    HTTP_OPTIONS, handleOptions);
  server.on("/connect", HTTP_OPTIONS, handleOptions);
  server.on("/right",   HTTP_OPTIONS, handleOptions);
  server.on("/left",    HTTP_OPTIONS, handleOptions);
  
  server.begin();
  Serial.println("[HTTP Server SUCCESS] Dynamic API listener fully active on Port 80");
}

void startAPFallbackMode() {
  Serial.println("\n[Network Setup] Triggering Local Access Point Provisioning Interface...");
  isApModeActive = true;

  WiFi.softAPdisconnect(true);
  WiFi.disconnect(true, true);
  delay(500);

  WiFi.mode(WIFI_AP_STA);
  delay(100);

  // Bring open configuration portal live directly inside the microchip
  bool success = WiFi.softAP(ap_ssid, ap_password, ap_channel, 0, 4);
  if (!success) {
    Serial.println("[AP Error] Failed to stabilize broadcast beacon loop.");
    delay(500);
    WiFi.softAP(ap_ssid, ap_password, ap_channel, 0, 4);
  }

  Serial.printf("[AP Operational] Portal live. Connect your phone to: %s\n", ap_ssid);
  Serial.print("[AP Operational] Navigate browser directly to: http://");
  Serial.println(WiFi.softAPIP());

  registerServerRoutes();
}

// ========== Setup Initialization Routine ==========
void setup() {
  Serial.begin(115200);
  myServo.attach(2, 500, 2500); // Attach servo to pin 2
  myServo.write(90);            // Stop/Neutral position
  delay(1000);
  Serial.println("\n=============================================");
  Serial.println("   ROBOCAM PURE-WIFI CAPTIVE ARCHITECTURE    ");
  Serial.println("=============================================");

  WiFi.onEvent(onWiFiEvent);

  preferences.begin("robocam", true);
  String saved_ssid = preferences.getString("ssid", "");
  String saved_pass = preferences.getString("pass", "");
  preferences.end();

  saved_ssid.trim();
  saved_pass.trim();

  if (saved_ssid.length() > 0) {
    Serial.printf("[Boot Core Evaluation] Saved network credentials discovered for SSID: %s\n", saved_ssid.c_str());
    
    WiFi.softAPdisconnect(true);
    delay(500);
    WiFi.mode(WIFI_STA);
    delay(500);

    Serial.printf("[WiFi Client Loop] Requesting network authorization handshake link...");
    WiFi.begin(saved_ssid.c_str(), saved_pass.c_str());

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
      delay(500);
      Serial.print(".");
      attempts++;
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("[WiFi Handshake Verified] Successfully registered onto target airwaves.");
      
      IPAddress currentIP = WiFi.localIP();
      IPAddress gatewayIP = WiFi.gatewayIP();
      IPAddress subnetMask = WiFi.subnetMask();
      
      // Compute static array offset location matching your router's unique subnet layout block dynamically
      IPAddress staticIP(currentIP[0], currentIP[1], currentIP[2], 200);
      
      Serial.printf("[Subnet Syncing] Pinning target static array offsets:\n");
      Serial.printf("   -> Local Target:  http://%s\n", staticIP.toString().c_str());
      Serial.printf("   -> Gateway Intercept: %s\n", gatewayIP.toString().c_str());
      
      WiFi.config(staticIP, gatewayIP, subnetMask);
      delay(200);
      
      Serial.printf("[System Ready] Device operations live at target route address: http://%s/\n", WiFi.localIP().toString().c_str());
      
      isApModeActive = false;
      registerServerRoutes();
    } else {
      Serial.println("[WiFi Handshake Timeout] Connection signature rejected by router.");
      startAPFallbackMode();
    }
  } else {
    Serial.println("[Boot Core Evaluation] System NVS flash memory empty. Skipping client mode.");
    startAPFallbackMode();
  }
}

// ========== Core Execution Loop ==========
void loop() {
  server.handleClient();
  
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "right") {
      myServo.write(180);      // Rotate Clockwise
      delay(5000);
      myServo.write(90);       // Stop
      Serial.println("Rotated Right");
    }
    else if (cmd == "left") {
      myServo.write(0);        // Rotate Anti-clockwise
      delay(5000);
      myServo.write(90);       // Stop
      Serial.println("Rotated Left");
    }
  }
  delay(1); 
}
