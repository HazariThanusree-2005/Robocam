# Real-Time Object Selection, Tracking, and Gesture-Based Recording using OpenCV

This Python application uses OpenCV, MediaPipe, and YOLOv8 to run real-time object selection, tracking, and gesture-controlled video recording from a laptop webcam.

---

## Features

1. **Simultaneous Real-Time Detection**:
   - **General Objects**: Detected using YOLOv8 (coco classes like person, cup, laptop, book, cell phone, etc.).
   - **Faces**: Detected using MediaPipe Face Detection.
   - **Hands**: Detected using MediaPipe Hands (with full landmark mapping).
2. **Gesture-Based Target Selection (Hover-to-Lock)**:
   - Hover the index fingertip inside any object or face bounding box for 3 seconds.
   - A visual countdown ring appears in the center of the frame.
   - Once the timer expires, the target is locked. All other bounding boxes disappear.
3. **Stable Single Object Tracking (CSRT)**:
   - Uses the highly stable OpenCV CSRT Tracker to follow the target even if it moves.
   - Continues tracking independently of detection models (which saves CPU cycles and provides resilience when the target is partially obscured).
4. **Left-Right Zone Determination**:
   - The video frame is split down the center.
   - The center point of the locked target is tracked.
   - If the center is on the left side of the divider, `LEFT` is printed; if on the right side, `RIGHT` is printed.
5. **Gesture-Based Video Recording**:
   - Toggles recording of the raw camera stream using the hand transition sequence: **Open Palm -> Closed Fist**.
   - Recording starts with a "RECORDING STARTED" console print and flashing red "REC" HUD text.
   - Performing the same sequence stops recording ("RECORDING STOPPED") and saves the session as a timestamped MP4 file under the `recordings/` folder.
6. **Robust Debouncing & Inter-Frame Matching**:
   - Utilizes Intersection over Union (IoU) to identify and match the hovered bounding box across frames, keeping countdown timers stable.
   - Implements a 2-second cooldown period after recording triggers to avoid false multiple starts/stops.

---

## Project Structure

```
d:/OpenCvRobocam/
│
├── camera.py             # Webcam capture wrapper (cv2.VideoCapture)
├── detector.py           # YOLOv8 + MediaPipe Face Detection
├── hand_tracker.py       # MediaPipe Hands tracking
├── gesture_controller.py # Gesture state machine (Open Palm -> Closed Fist)
├── recorder.py           # OpenCV VideoWriter for saving timestamped MP4
├── object_selector.py    # Finger hover selector (IoU-based)
├── tracker.py            # CSRT Tracker and Left-Right calculations
├── utils.py              # Hardware communication (send_direction) & HUD drawing
├── main.py               # Main application orchestration loop
└── README.md             # This guide
```

---

## Installation Guide

### Prerequisites
- Python 3.8 to 3.13 (Python 3.13.3 tested and fully supported).
- Webcam-enabled laptop or external USB webcam.

### Step 1: Install Dependencies
Run the following pip commands in your command prompt or terminal:

```bash
pip install opencv-python opencv-contrib-python mediapipe ultralytics numpy imutils deep-sort-realtime
```

*Note: `opencv-contrib-python` is required because it contains the tracking modules (CSRT tracker).*

---

## Execution Instructions

1. Navigate to the project directory:
   ```bash
   cd d:\OpenCvRobocam
   ```
2. Run the main entry script:
   ```bash
   python main.py
   ```
3. Allow a few seconds on first startup for the YOLOv8 weight file (`yolov8n.pt`) to download automatically.

### User Controls
- **Select & Lock**: Move your hand to the camera. Hover your index finger tip inside any orange bounding box. Keep it there for 3 seconds. The center HUD will countdown from `3.0s` to `0.0s`, and the box will turn **blue** and lock.
- **Start/Stop Recording**: Hold up an **Open Palm** (all fingers extended) for a split second, then quickly fold your hand into a **Closed Fist** (all fingers folded). The HUD will flash a red `REC: RECORDING` indicator and print `[GESTURE] Transition detected: RECORDING STARTED`. Repeat the gesture to stop.
- **Unlock Target**: Press `r` on the keyboard to unlock the current object and return to searching.
- **Exit**: Press `q` or `ESC` to release webcam hardware and exit.

---

## Hardware Communication Logic

The application outputs direction commands through a dedicated utility function:
```python
send_direction(direction)
```
- Direction parameters: `"LEFT"`, `"RIGHT"`, or `"N/A"`
- Output is throttled so that commands are printed only when the target actually changes sides, preventing command flooding.
- Developers can easily bind this function to serial ports (e.g. `pyserial` for Arduino), WebSockets, or ROS topics to control physical hardware/gimbals.

---

## Error Handling & Troubleshooting

1. **Webcam fails to initialize**:
   - Ensure no other application (like Zoom, Teams, or browser) is currently using the camera.
   - If using an external USB camera, change the source index in `main.py` from `src=0` to `src=1` or `src=2`.
2. **"CSRT Tracker is not available" / AttributeError**:
   - This occurs if the basic `opencv-python` package was installed without `opencv-contrib-python`.
   - Run `pip uninstall opencv-python opencv-contrib-python` and then reinstall using:
     `pip install opencv-contrib-python`
3. **Slow FPS/Performance lag**:
   - Ensure your laptop is plugged into power (some OS power saving modes limit CPU performance).
   - The application is optimized to run YOLOv8 on CPU using the nano model. Under typical operations, it achieves >20 FPS.
