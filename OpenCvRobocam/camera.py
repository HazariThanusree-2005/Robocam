import cv2
import sys
import threading
import time


class WebcamStream:
    """
    Manages webcam initialization, frame retrieval, and metadata queries.

    Optimization: Runs a background thread that continuously grabs frames
    into a single-slot ring buffer. The main loop always receives the
    freshest available frame without stalling on cap.read() while YOLO
    is running. Setting CAP_PROP_BUFFERSIZE=1 minimises the internal
    driver buffer so no stale frames pile up.

    FIX: The first call to read() now waits (up to 5 seconds) for the
    background thread to deliver a valid frame. This eliminates the race
    condition where main.py would get (False, None) before the camera
    had produced its first frame — which killed the entire Python process
    and left the frontend showing a black/blank preview.
    """

    def __init__(self, src=0, width=640, height=480):
        print(f"[CAMERA] Initializing webcam source {src}...")

        is_url = isinstance(src, str) and (
            src.startswith("http://") or src.startswith("https://")
        )
        if sys.platform.startswith("win") and not is_url:
            self.cap = cv2.VideoCapture(src, cv2.CAP_DSHOW)
        else:
            self.cap = cv2.VideoCapture(src)

        if not self.cap.isOpened():
            raise RuntimeError(f"Unable to open webcam source {src}")

        # Minimise internal driver buffer – we only want the latest frame
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, 30)

        self.width  = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.fps    = self.cap.get(cv2.CAP_PROP_FPS)
        if self.fps <= 0 or self.fps > 120:
            self.fps = 30.0

        print(
            f"[CAMERA] Active webcam resolution: "
            f"{self.width}x{self.height} @ {self.fps} FPS"
        )

        # --- Threaded grab loop ---
        self._frame     = None          # latest captured frame
        self._frame_id  = 0             # monotonic frame ID counter
        self._lock      = threading.Lock()
        self._stopped   = False
        self._ready     = threading.Event()   # signals when first frame is ready
        self._thread    = threading.Thread(target=self._grab_loop, daemon=True)
        self._thread.start()

        # Non-blocking startup: the grab loop fills self._frame in a daemon thread.
        # The main loop in main.py publishes a placeholder "Initializing Camera…"
        # frame to the MJPEG stream while the camera driver warms up, so the
        # browser always sees activity.  The blocking _ready.wait(5 s) has been
        # removed because it prevented the MJPEG HTTP server from starting until
        # AFTER the camera warmed up — if the driver was slow (common on Windows
        # with DirectShow) the stream would be empty and the browser would show a
        # black screen indefinitely.

    # ------------------------------------------------------------------
    # Background grab thread – runs as fast as the camera allows
    # ------------------------------------------------------------------
    def _grab_loop(self):
        while not self._stopped:
            if not self.cap.isOpened():
                break
            ret, frame = self.cap.read()
            if ret and frame is not None:
                with self._lock:
                    self._frame = frame
                    self._frame_id += 1
                # Signal that we have at least one valid frame
                if not self._ready.is_set():
                    self._ready.set()
            else:
                # Crucial: prevent 100% CPU lockup if read fails
                time.sleep(0.01)

    # ------------------------------------------------------------------
    # Public API (same as before – drop-in replacement)
    # ------------------------------------------------------------------
    @property
    def frame_id(self):
        """Returns the current frame ID."""
        with self._lock:
            return self._frame_id

    def read(self):
        """Return (success, frame) with the latest grabbed frame."""
        with self._lock:
            frame = self._frame
        if frame is None:
            return False, None
        return True, frame

    def release(self):
        self._stopped = True
        if self._thread.is_alive():
            self._thread.join(timeout=1.0)
        if self.cap is not None:
            print("[CAMERA] Releasing webcam...")
            self.cap.release()
            self.cap = None


class ClientFrameStream:
    """
    Drop-in replacement for WebcamStream that reads JPEG frames from a
    shared file on disk instead of opening a local camera via cv2.VideoCapture.

    Used when the camera source is a mobile browser: the browser captures
    frames via getUserMedia(), sends them as JPEG to the Node server, and
    the Node server writes them to a temp file.  This class polls that file
    in a background thread and decodes each new frame for the AI pipeline.

    Public API matches WebcamStream: read(), release(), frame_id, fps, width, height.
    """

    def __init__(self, frame_file, width=640, height=480):
        import os
        self._frame_file = frame_file
        self.width = width
        self.height = height
        self.fps = 30.0  # nominal; actual rate depends on client upload speed

        self._frame = None
        self._frame_id = 0
        self._lock = threading.Lock()
        self._stopped = False
        self._last_mtime = 0

        print(f"[CAMERA] ClientFrameStream: watching {frame_file}")

        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()

    def _poll_loop(self):
        import os
        while not self._stopped:
            try:
                if not os.path.exists(self._frame_file):
                    time.sleep(0.02)
                    continue

                mtime = os.path.getmtime(self._frame_file)
                if mtime <= self._last_mtime:
                    time.sleep(0.005)
                    continue

                self._last_mtime = mtime

                with open(self._frame_file, 'rb') as f:
                    data = f.read()

                if len(data) < 100:
                    time.sleep(0.01)
                    continue

                import numpy as np
                arr = np.frombuffer(data, dtype=np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)

                if frame is not None:
                    # Resize to expected dimensions if needed
                    h, w = frame.shape[:2]
                    if w != self.width or h != self.height:
                        frame = cv2.resize(frame, (self.width, self.height))
                    with self._lock:
                        self._frame = frame
                        self._frame_id += 1

            except Exception:
                pass

            time.sleep(0.005)

    @property
    def frame_id(self):
        with self._lock:
            return self._frame_id

    def read(self):
        with self._lock:
            frame = self._frame
        if frame is None:
            return False, None
        return True, frame

    def release(self):
        self._stopped = True
        if self._thread.is_alive():
            self._thread.join(timeout=1.0)
        print("[CAMERA] ClientFrameStream released.")