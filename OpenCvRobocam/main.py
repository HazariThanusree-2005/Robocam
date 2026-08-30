import cv2
import sys
import time
from camera import WebcamStream, ClientFrameStream
from detector import ObjectFaceDetector
from hand_tracker import HandTracker
from tracker import ObjectTracker
from object_selector import ObjectSelector
from utils import send_direction, reset_direction
from recorder import VideoRecorder
from gesture_controller import GestureController

# Monkey patch VideoRecorder.start and stop to print log without modifying recorder.py
_orig_start = VideoRecorder.start
def new_start(self, width, height, fps=30.0):
    print("[RECORDER] START FUNCTION CALLED")
    return _orig_start(self, width, height, fps)
VideoRecorder.start = new_start

_orig_stop = VideoRecorder.stop
def new_stop(self):
    print("[RECORDER] stopRecording() called")
    ret = _orig_stop(self)
    print("[RECORDER] Recording stopped successfully")
    return ret
VideoRecorder.stop = new_stop


import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
import numpy as np
from PIL import Image, ImageDraw, ImageFont

latest_frame = None
frame_lock = threading.Lock()

class CamHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence HTTP logs
        return

    def do_GET(self):
        global latest_frame
        if self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.end_headers()
            try:
                while True:
                    with frame_lock:
                        img_data = latest_frame
                    if img_data is not None:
                        self.wfile.write(b'--frame\r\n')
                        self.wfile.write(b'Content-Type: image/jpeg\r\n')
                        self.wfile.write(f'Content-Length: {len(img_data)}\r\n\r\n'.encode('utf-8'))
                        self.wfile.write(img_data)
                        self.wfile.write(b'\r\n')
                    time.sleep(0.033)
            except Exception as e:
                pass
        else:
            self.send_response(404)
            self.end_headers()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True

def get_cameras_list():
    import sys
    import subprocess
    import json as _json
    import platform

    # Probe indices to see which ones are openable
    available_cameras_info = {}
    for idx in range(10):
        try:
            if sys.platform.startswith("win"):
                cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
            else:
                cap = cv2.VideoCapture(idx)
            if cap is not None and cap.isOpened():
                w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                available_cameras_info[idx] = {"width": w, "height": h}
                cap.release()
            else:
                if cap is not None:
                    cap.release()
        except Exception:
            pass

    available_indices = sorted(list(available_cameras_info.keys()))
    cameras = []
    
    # Try to get system camera labels
    labels = []
    system_platform = sys.platform.lower()
    
    if system_platform.startswith("win"):
        try:
            cmd = ["powershell", "-Command", "Get-PnpDevice -Class Camera -Status OK | Select-Object -ExpandProperty FriendlyName"]
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
            labels = [line.strip() for line in out.splitlines() if line.strip()]
        except Exception:
            pass
    elif system_platform.startswith("darwin"):
        try:
            out = subprocess.check_output(["system_profiler", "SPCameraDataType"], stderr=subprocess.DEVNULL, text=True)
            for line in out.splitlines():
                if "Camera" in line or "Model" in line or "Webcam" in line:
                    parts = line.split(":", 1)
                    if len(parts) > 1:
                        labels.append(parts[1].strip())
        except Exception:
            pass
    elif "linux" in system_platform:
        try:
            out = subprocess.check_output(["termux-camera-info"], stderr=subprocess.DEVNULL, text=True)
            info = _json.loads(out)
            for cam in info:
                idx = int(cam.get("id", 0))
                facing = cam.get("facing", "unknown")
                if idx in available_indices:
                    cameras.append({
                        "index": idx,
                        "label": f"Android {facing.capitalize()} Camera ({idx})",
                        "facing": facing,
                        "width": available_cameras_info[idx]["width"],
                        "height": available_cameras_info[idx]["height"]
                    })
            return cameras
        except Exception:
            pass

    for i, idx in enumerate(available_indices):
        label = labels[i] if i < len(labels) else f"Camera {idx}"
        
        # Determine facing mode based on label or heuristics
        label_lower = label.lower()
        facing = "unknown"
        if any(w in label_lower for w in ["front", "user", "selfie", "integrated", "internal", "facetime"]):
            facing = "front"
        elif any(w in label_lower for w in ["back", "rear", "environment", "outer", "main"]):
            facing = "back"
        else:
            # Heuristic fallback if unknown
            if len(available_indices) == 1:
                facing = "front"
            elif len(available_indices) == 2:
                is_mobile_platform = any(k in system_platform for k in ["android", "ios", "iphone", "ipad"])
                if is_mobile_platform:
                    facing = "back" if idx == 0 else "front"
                else:
                    facing = "front" if idx == 0 else "back"
            else:
                facing = "front" if idx == 0 else "back" if idx == 1 else "unknown"
                
        cameras.append({
            "index": idx,
            "label": label,
            "facing": facing,
            "width": available_cameras_info[idx]["width"],
            "height": available_cameras_info[idx]["height"]
        })
        
    return cameras

def main():
    import argparse
    import json as _json
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", type=str, default=None, help="ESP32 IP address")
    parser.add_argument("--camera", type=str, default="front", help="Camera source (front/back or index)")
    parser.add_argument("--enumerate", action="store_true", help="Enumerate available cameras and exit")
    args, unknown = parser.parse_known_args()

    # Camera enumeration mode: probe indices and print JSON result, then exit
    if args.enumerate:
        cameras = get_cameras_list()
        print(_json.dumps({"cameras": cameras}))
        sys.exit(0)

    if args.ip:
        import utils
        utils.esp32_ip = args.ip
        print(f"[SYSTEM] Targeted ESP32 hardware IP address: {args.ip}")

    cam_src = args.camera
    is_client_camera = (cam_src.lower() == 'client')

    if not is_client_camera:
        cameras_list = get_cameras_list()
        # Try to find camera matching 'front' or 'back'
        if cam_src.lower() == 'front':
            matched = next((c for c in cameras_list if c["facing"] == "front"), None)
            if matched is not None:
                cam_src = matched["index"]
            else:
                cam_src = cameras_list[0]["index"] if cameras_list else 0
        elif cam_src.lower() == 'back':
            matched = next((c for c in cameras_list if c["facing"] == "back"), None)
            if matched is not None:
                cam_src = matched["index"]
            else:
                cam_src = cameras_list[0]["index"] if cameras_list else 0
        else:
            try:
                cam_src = int(cam_src)
            except ValueError:
                pass

    print("==========================================================")
    print("  Real-Time Object Selection & Movement Tracking")
    print("==========================================================")
    print("Controls:")
    print("  - Double-tap index fingertip on a box to select target.")
    print("  - Press 'r' to unlock and return to detection mode.")
    print("  - Press 'q' or 'ESC' to exit.")
    print("==========================================================")

    # Stdin command listener for non-GUI reset and exit control
    reset_flag = [False]
    exit_flag = [False]

    def stdin_listener():
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                cmd = line.strip().lower()
                if cmd == 'r':
                    reset_flag[0] = True
                elif cmd == 'q':
                    exit_flag[0] = True
            except Exception:
                break

    threading.Thread(target=stdin_listener, daemon=True).start()

    # ── 1. Start MJPEG Stream Server FIRST ──────────────────────────────────────
    # This must happen before camera initialisation so that checkStreamPort()
    # in the Node server succeeds immediately.  Previously the server started
    # AFTER camera init, which blocked for up to 5 s (or hung indefinitely on
    # slow DirectShow drivers), keeping the port closed and the React UI stuck
    # on "Initialising Camera…" / black screen forever.
    try:
        server = ThreadedHTTPServer(('127.0.0.1', 5000), CamHandler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        print("[SYSTEM] MJPEG stream server active on http://127.0.0.1:5000/stream")
    except Exception as e:
        print(f"[WARNING] Failed to start MJPEG streaming server: {e}")

    # ── 2. Publish a placeholder frame immediately ─────────────────────────────
    # The browser's <img> connects as soon as streamActive=true is reported.
    # Without an initial frame, the MJPEG handler loops silently on latest_frame=None
    # and the browser shows a blank/black image.  Publishing a placeholder here
    # gives the browser real MJPEG data from the very first request so it always
    # shows something while the camera and YOLO model warm up.
    try:
        _ph = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.putText(_ph, "Initializing Camera...", (110, 225),
                    cv2.FONT_HERSHEY_DUPLEX, 0.9, (200, 200, 200), 2, cv2.LINE_AA)
        cv2.putText(_ph, "Please wait", (225, 265),
                    cv2.FONT_HERSHEY_DUPLEX, 0.6, (140, 140, 140), 1, cv2.LINE_AA)
        _, _ph_jpg = cv2.imencode('.jpg', _ph)
        with frame_lock:
            latest_frame = _ph_jpg.tobytes()
    except Exception:
        pass

    # ── 3. Initialize camera ───────────────────────────────────────────────────
    try:
        if is_client_camera:
            # Mobile browser sends frames via the Node server → temp file
            import os
            frame_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'latest_client_frame.jpg')
            camera = ClientFrameStream(frame_file=frame_file, width=640, height=480)
            print("[SYSTEM] Using ClientFrameStream (mobile browser camera)")
        else:
            camera = WebcamStream(src=cam_src, width=640, height=480)
    except Exception as e:
        print(f"[FATAL] Camera initialization failed: {e}")
        sys.exit(1)

    # ── 4. Load remaining components ──────────────────────────────────────────
    detector = ObjectFaceDetector(yolo_model_path="yolo11m.pt")
    hand_tracker = HandTracker(max_num_hands=2)
    tracker = ObjectTracker()
    selector = ObjectSelector(tap_window=0.8)
    gesture_controller = GestureController()
    recorder = VideoRecorder()

    # Warm up PyAudio in the background while the camera and YOLO warm up.
    # This prevents the initial multisecond lag when the user first starts recording.
    def audio_warmup_worker():
        try:
            recorder.warmup_audio()
        except Exception:
            pass
    threading.Thread(target=audio_warmup_worker, daemon=True, name="audio-warmup").start()

    # UI colors
    COLOR_DEFAULT_BOX = (0, 165, 255)  # Orange
    COLOR_HOVER_BOX = (0, 255, 255)    # Yellow
    COLOR_LOCKED_BOX = (0, 255, 0)      # Green

    current_direction = ""
    selection_time = None
    smoothed_fingertip = None
    unlock_hover_start = None   # Timestamp when fingertip started hovering on locked box
    object_locked = False       # State variable: Selection Mode (False) vs Tracking Mode (True)

    # Command throttling and optimization variables
    last_command = "RELEASE"
    last_command_time = 0.0
    COMMAND_COOLDOWN = 5.2
    hand_results = None

    frame_count = 0
    consecutive_read_failures = 0    # Retry counter for camera warmup tolerance
    # Frame pacing for real-time recording: track wall-clock time per frame
    frame_interval = 1.0 / camera.fps  # seconds between frames at true FPS
    last_frame_time = time.time()
    last_processed_fid = 0

    try:
        while True:
            # Check frame ID pacing to prevent processing the same frame multiple times.
            # This maintains exactly 30 FPS processing matching the camera rate, and saves CPU.
            fid = camera.frame_id
            if fid == last_processed_fid:
                time.sleep(0.002)
                continue

            frame_count += 1
            # 1. Capture frame (with retry tolerance for camera warmup)
            success, frame = camera.read()
            if not success or frame is None:
                consecutive_read_failures += 1

                # Publish a live "warming up" placeholder every 5 retries so the
                # MJPEG stream always delivers data to the browser while the camera
                # driver initialises.  Without this the browser's <img> receives
                # HTTP 200 but zero bytes and renders nothing (black/blank screen).
                if consecutive_read_failures % 5 == 0:
                    try:
                        _wph = np.zeros((480, 640, 3), dtype=np.uint8)
                        cv2.putText(_wph, "Camera warming up...", (120, 225),
                                    cv2.FONT_HERSHEY_DUPLEX, 0.85, (200, 200, 200), 2, cv2.LINE_AA)
                        cv2.putText(_wph, f"({consecutive_read_failures} retries)", (210, 265),
                                    cv2.FONT_HERSHEY_DUPLEX, 0.55, (120, 120, 120), 1, cv2.LINE_AA)
                        _, _wph_jpg = cv2.imencode('.jpg', _wph)
                        with frame_lock:
                            latest_frame = _wph_jpg.tobytes()
                    except Exception:
                        pass

                # Allow retries for camera warmup / client frame upload
                max_retries = 900 if is_client_camera else 150
                if consecutive_read_failures >= max_retries:
                    print(f"[ERROR] Camera failed to deliver frames after {max_retries} retries. Exiting...")
                    break

                time.sleep(0.033)
                continue
            last_processed_fid = fid
            consecutive_read_failures = 0   # reset on success

            # ── 5. Robust Frame Processing try-except wrapper ───────────────────────
            # Wrap all YOLO, face detection, hand tracking, and drawing logic in a
            # try-except block so that if any of these operations fail/throw an
            # exception, the camera stream remains open, the raw frame is still
            # delivered to the MJPEG server, and the system continues running.
            try:
                # Mirror frame for intuitive laptop webcam interaction
                frame = cv2.flip(frame, 1)
                h, w, _ = frame.shape

                # Always keep a clean (overlay-free) copy of the current frame.
                # This is used exclusively for video recording so the saved file
                # never contains bounding boxes, the yellow dot, or any other overlay.
                clean_frame = frame.copy()

                # Pre-convert BGR frame to RGB once to reuse across hand tracker & detector
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                # 2. State-Based Processing (Selection vs Tracking)
                # Run YOLO/Face detection asynchronously (non-blocking)
                detections = detector.detect_all(
                    frame, 
                    rgb_frame=rgb_frame, 
                    object_locked=object_locked, 
                    tracking_label=tracker.label if object_locked else None
                )

                if not object_locked:
                    # ── STATE 1: OBJECT SELECTION MODE ──
                    # Hand Detection = ENABLED
                    # Yellow Index Dot = VISIBLE
                    # Long Press = ENABLED
                    # Object Tracking = DISABLED

                    # 1. Run hand detection for selection (every frame for cursor responsiveness)
                    fingertips = []
                    active_hand_landmarks = None

                    hand_results = hand_tracker.process(frame, rgb_frame=rgb_frame)
                    if hand_results.multi_hand_landmarks:
                        active_hand_landmarks = hand_results.multi_hand_landmarks[0]

                        # ── POINTING GESTURE GATE ────────────────────────────────
                        # The yellow dot and selection logic ONLY activate when the
                        # user intentionally points with ONLY the index finger.
                        # Holding a phone, pen, or resting a hand will NOT trigger
                        # the dot because other fingers remain extended.
                        is_pointing = hand_tracker.is_pointing_gesture(active_hand_landmarks)

                        if is_pointing:
                            ft_coords = hand_tracker.get_index_fingertip(active_hand_landmarks, w, h)
                            # Exponential Moving Average (EMA) for stability
                            if smoothed_fingertip is None:
                                smoothed_fingertip = list(ft_coords)
                            else:
                                finger_alpha = 0.35
                                smoothed_fingertip[0] = int(finger_alpha * ft_coords[0] + (1 - finger_alpha) * smoothed_fingertip[0])
                                smoothed_fingertip[1] = int(finger_alpha * ft_coords[1] + (1 - finger_alpha) * smoothed_fingertip[1])
                            fingertips = [tuple(smoothed_fingertip)]
                        else:
                            # Hand is detected but the pointing gesture is NOT active.
                            # Reset the smoothed cursor so no stale dot remains visible.
                            smoothed_fingertip = None
                            fingertips = []
                    else:
                        smoothed_fingertip = None
                        fingertips = []       # explicit reset — already set above, belt-and-suspenders

                    # 2. Update selector with detections and fingertips
                    selected_item, tap_count, is_locked = selector.update(
                        detections, fingertips, frame_area=w*h, hand_landmarks=active_hand_landmarks
                    )

                    # 3. Handle selection and transition to Tracking Mode
                    if selected_item is not None and is_locked:
                        neg_pts = None
                        h_mask = None
                        if active_hand_landmarks is not None:
                            neg_pts = hand_tracker.get_hand_exclusion_points(active_hand_landmarks, w, h)
                            h_mask = hand_tracker.get_hand_mask(active_hand_landmarks, w, h)
                        tracker_ok = tracker.init_tracker(
                            frame,
                            selected_item["box"],
                            label=selected_item["label"],
                            detector=detector,
                            track_id=selected_item.get("id"),
                            point=selected_item.get("point"),
                            negative_points=neg_pts,
                            hand_mask=h_mask
                        )
                        if tracker_ok:
                            selection_time = time.time()
                            gesture_controller.reset_gesture()
                            object_locked = True
                            smoothed_fingertip = None
                            fingertips = []
                            last_command = "RELEASE"
                            last_command_time = 0.0
                        selector.reset_hover()
                else:
                    # ── STATE 2: OBJECT TRACKING MODE ──
                    # Hand Detection (for selection) = DISABLED
                    # Yellow Index Dot = HIDDEN
                    # Long Press (for selection) = DISABLED
                    # Object Tracking = ENABLED

                    # Run hand detection strictly for gesture controller and dedicated manual unlock check.
                    hand_results = hand_tracker.process(frame, rgb_frame=rgb_frame)
                    if hand_results and hand_results.multi_hand_landmarks:
                        print("[HAND] Hand Detected")
                    else:
                        print("[HAND] No Hand")
                    
                    smoothed_fingertip = None
                    fingertips = []

                    # 1. Check for record start/stop gesture using the dedicated fist toggle
                    gesture_action = gesture_controller.update(hand_results, is_recording=recorder.is_recording)
                    print(f"gesture_action = {gesture_action}")

                    if gesture_action == "START":
                        print("[MAIN] Received START")
                        print("[MAIN] Calling recorder.start()")
                        print(f"[PIPELINE] Gesture returned START. recorder.is_recording={recorder.is_recording}")
                        if not recorder.is_recording:
                            print("[PIPELINE] Calling recorder.start()...")
                            success_rec = recorder.start(w, h, fps=camera.fps)
                            if success_rec:
                                print(f"[PIPELINE] recorder.start() succeeded. is_recording={recorder.is_recording}")
                            else:
                                print("[PIPELINE] ERROR: recorder.start() returned False! Recording did not start.")
                        else:
                            print("[PIPELINE] WARNING: START received but recorder already active")
                    elif gesture_action == "STOP":
                        print("[MAIN] Received STOP")
                        print(f"[PIPELINE] Gesture returned STOP. recorder.is_recording={recorder.is_recording}")
                        if recorder.is_recording:
                            recorder.stop()
                            print(f"[PIPELINE] recorder.stop() called. is_recording={recorder.is_recording}")
                        else:
                            print("[PIPELINE] WARNING: STOP received but recorder not active")

                    # 2. Update object tracking
                    cur_hand_mask = None
                    if hand_results and hand_results.multi_hand_landmarks:
                        cur_hand_mask = hand_tracker.get_hand_mask(hand_results.multi_hand_landmarks[0], w, h)

                    track_success, bbox_xyxy = tracker.update(
                        frame,
                        detector=detector,
                        precomputed_detections=detections,
                        hand_mask=cur_hand_mask
                    )

                    if not track_success:
                        print("[MAIN] Locked target lost/left frame. Automatically returning to initial state.")
                        reset_direction()
                        current_direction = ""
                        tracker.reset()
                        selector.reset_lock()
                        gesture_controller.reset_gesture()
                        unlock_hover_start = None
                        object_locked = False
                        if recorder.is_recording:
                            recorder.stop()
                            print("[MAIN] Recording stopped (locked target lost)")
                        detections = []
                        continue

                    # --- Dedicated Unlock check on the locked object's bounding box ---
                    # Read the RAW fingertip directly from hand_results. No dot is drawn.
                    unlock_ft = None
                    if hand_results and hand_results.multi_hand_landmarks and bbox_xyxy is not None:
                        raw_lm = hand_results.multi_hand_landmarks[0]
                        # ONLY perform unlock check if the user is showing the pointing gesture.
                        # If they are just holding a phone, pen, or bottle, other fingers will
                        # be folded or extended differently, so it will not trigger unlock.
                        if hand_tracker.is_pointing_gesture(raw_lm):
                            unlock_ft = hand_tracker.get_index_fingertip(raw_lm, w, h)

                    if unlock_ft is not None and bbox_xyxy is not None:
                        fx, fy = unlock_ft
                        ux1, uy1, ux2, uy2 = bbox_xyxy
                        padding = 20
                        if (ux1 - padding) <= fx <= (ux2 + padding) and (uy1 - padding) <= fy <= (uy2 + padding):
                            # Fingertip is inside the locked box
                            if unlock_hover_start is None:
                                unlock_hover_start = time.time()
                            elif time.time() - unlock_hover_start >= 2.0:
                                # 2-second long-press confirmed → UNLOCK
                                print("[MAIN] Manual unlock (long-press on locked object)")
                                reset_direction()
                                current_direction = ""
                                tracker.reset()
                                selector.reset_lock()
                                gesture_controller.reset_gesture()
                                unlock_hover_start = None
                                object_locked = False
                                if recorder.is_recording:
                                    recorder.stop()
                                    print("RECORDING STOPPED (manual unlock)")
                                detections = []
                                continue
                        else:
                            unlock_hover_start = None
                    else:
                        unlock_hover_start = None

                    # Only command movement if the target is currently visible in the frame.
                    # If target is temporarily lost/occluded, target_visible is False, so direction is reset
                    # and no movement command is sent.
                    if getattr(tracker, 'target_visible', True):
                        # Compute movement direction relative to the internal center reference
                        frame_center_x = w // 2
                        mov_dir = tracker.get_movement_direction(frame_center_x)
                        
                        cmd_to_send = None
                        if mov_dir == "MOVED LEFT":
                            cmd_to_send = "MOVED LEFT"
                        elif mov_dir == "MOVED RIGHT":
                            cmd_to_send = "MOVED RIGHT"
                        else:
                            cmd_to_send = "RELEASE"

                        now = time.time()

                        # Throttled network commands to match ESP32 5.0-second delay handler
                        if cmd_to_send == "RELEASE":
                            if last_command != "RELEASE":
                                reset_direction()
                                current_direction = ""
                                last_command = "RELEASE"
                        else:
                            if cmd_to_send != last_command or (now - last_command_time) >= COMMAND_COOLDOWN:
                                last_command = cmd_to_send
                                last_command_time = now
                                
                                if cmd_to_send == "MOVED LEFT":
                                    current_direction = "MOVED LEFT"
                                    print("MOVED LEFT")
                                    send_direction("LEFT")
                                elif cmd_to_send == "MOVED RIGHT":
                                    current_direction = "MOVED RIGHT"
                                    print("MOVED RIGHT")
                                    send_direction("RIGHT")
                    else:
                        if last_command != "RELEASE":
                            reset_direction()
                            current_direction = ""
                            last_command = "RELEASE"

                # Draw red recording indicator (● REC) in top-left corner if active
                if recorder.is_recording:
                    cv2.circle(frame, (30, 35), 8, (0, 0, 255), -1, cv2.LINE_AA)
                    cv2.putText(frame, "REC", (48, 43), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2, cv2.LINE_AA)

                # Draw ONLY the INDEX_FINGER_TIP dot – selection mode only.
                # smoothed_fingertip is guaranteed None during tracking mode
                # because the entire fingertip pipeline is disabled.
                if smoothed_fingertip is not None and not object_locked:
                    cv2.circle(frame, (smoothed_fingertip[0], smoothed_fingertip[1]), 8, (0, 255, 255), -1, cv2.LINE_AA)

                # Draw bounding boxes
                if object_locked:
                    # Draw the green selected box ONLY if the target is currently visible
                    if getattr(tracker, 'target_visible', True) and 'bbox_xyxy' in locals() and bbox_xyxy is not None:
                        x1, y1, x2, y2 = bbox_xyxy
                        cv2.rectangle(frame, (x1, y1), (x2, y2), COLOR_LOCKED_BOX, 3, cv2.LINE_AA)
                else:
                    # Draw all detection bounding boxes ONLY (no labels)
                    for det in detections:
                        box = det["box"]
                        is_hovered = ('selected_item' in locals() and selected_item is not None and selected_item["id"] == det["id"])
                        # Candidate = YELLOW (COLOR_HOVER_BOX), others = ORANGE (COLOR_DEFAULT_BOX)
                        box_color = COLOR_HOVER_BOX if is_hovered else COLOR_DEFAULT_BOX
                        line_thickness = 3 if is_hovered else 1

                        cv2.rectangle(frame, (box[0], box[1]), (box[2], box[3]), box_color, line_thickness, cv2.LINE_AA)

                        if is_hovered and selector.hover_start_time is not None:
                            elapsed = time.time() - selector.hover_start_time
                            remaining = max(0.0, 2.0 - elapsed)
                            cv2.putText(frame, f"{remaining:.1f}s", (box[0], box[1] - 10),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, COLOR_HOVER_BOX, 2, cv2.LINE_AA)

                # Write frame to video recorder if active (watermarking runs on recorder thread)
                if recorder.is_recording:
                    recorder.write(clean_frame)
            except Exception as inner_e:
                print(f"[ERROR] Exception during frame processing: {inner_e}")
                import traceback
                traceback.print_exc()

            # Convert frame to JPEG and update streaming buffer
            try:
                success_jpeg, encoded_img = cv2.imencode('.jpg', frame)
                if success_jpeg:
                    with frame_lock:
                        latest_frame = encoded_img.tobytes()
            except Exception as e:
                pass

            # Frame pacing: track timing for recorder reference only.
            # The blocking time.sleep() has been removed — the main loop
            # now runs as fast as possible. JPEG encode + imshow + async YOLO
            # already consume the available frame budget without artificial sleeping.
            last_frame_time = time.time()

            # Display the frame in a separate OpenCV window
            key = 0xFF
            try:
                cv2.imshow("RoboCam Cruise Control", frame)
                key = cv2.waitKey(1) & 0xFF
            except Exception as e:
                # Timing is now perfectly paced by frame_id at the start of the loop
                pass

            # Check stdin commands or keypresses
            is_reset = (key == ord('r') or reset_flag[0])
            is_exit = (key == ord('q') or key == 27 or exit_flag[0])

            if is_reset:
                reset_flag[0] = False
                print("[SYSTEM] Manual reset. Returning to detection mode.")
                reset_direction()
                current_direction = ""
                selection_time = None
                tracker.reset()
                selector.reset_lock()
                object_locked = False
                detections = []

            if is_exit:
                exit_flag[0] = False
                print("[SYSTEM] Exit requested.")
                break

    except Exception as e:
        print(f"[CRITICAL ERROR] {e}")
        import traceback
        traceback.print_exc()

    finally:
        print("[SYSTEM] Cleaning up resources...")
        recorder.cleanup()
        camera.release()
        detector.close()
        hand_tracker.close()
        cv2.destroyAllWindows()
        print("[SYSTEM] Exit complete.")

if __name__ == "__main__":
    main()
