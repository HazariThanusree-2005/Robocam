import cv2
import math
import numpy as np

# ---------------------------------------------------------------------------
# KalmanFilter2D — Position & Velocity Kalman Filter
# ---------------------------------------------------------------------------

class KalmanFilter2D:
    """
    2D Kalman Filter for tracking position (x, y) and velocity (vx, vy).
    State vector: [x, y, vx, vy]^T
    """
    def __init__(self):
        self.state = np.zeros((4, 1), dtype=np.float32)
        self.F = np.array([
            [1, 0, 1, 0],
            [0, 1, 0, 1],
            [0, 0, 1, 0],
            [0, 0, 0, 1]
        ], dtype=np.float32)
        self.H = np.array([
            [1, 0, 0, 0],
            [0, 1, 0, 0]
        ], dtype=np.float32)
        self.P = np.eye(4, dtype=np.float32) * 100.0
        self.Q = np.eye(4, dtype=np.float32) * 1.0
        self.R = np.eye(2, dtype=np.float32) * 10.0
        self.initialized = False

    def init(self, x, y):
        self.state = np.array([[x], [y], [0], [0]], dtype=np.float32)
        self.P = np.eye(4, dtype=np.float32) * 10.0
        self.initialized = True

    def predict(self):
        if not self.initialized:
            return 0.0, 0.0
        self.state = np.dot(self.F, self.state)
        self.P = np.dot(np.dot(self.F, self.P), self.F.T) + self.Q
        return float(self.state[0, 0]), float(self.state[1, 0])

    def update(self, x, y):
        if not self.initialized:
            self.init(x, y)
            return x, y
        self.predict()
        z = np.array([[x], [y]], dtype=np.float32)
        y_residual = z - np.dot(self.H, self.state)
        S = np.dot(np.dot(self.H, self.P), self.H.T) + self.R
        K = np.dot(np.dot(self.P, self.H.T), np.linalg.inv(S))
        self.state = self.state + np.dot(K, y_residual)
        self.P = np.dot((np.eye(4, dtype=np.float32) - np.dot(K, self.H)), self.P)
        return float(self.state[0, 0]), float(self.state[1, 0])


class TargetState:
    NO_TARGET          = "NO_TARGET"
    TARGET_SELECTED    = "TARGET_SELECTED"
    TARGET_TRACKING    = "TARGET_TRACKING"
    TARGET_LOST        = "TARGET_LOST"
    TARGET_REACQUIRING = "TARGET_REACQUIRING"
    TARGET_UNLOCKED    = "TARGET_UNLOCKED"


CSRT_REINIT_THRESHOLD = 60   # pixels
MAX_MISSING_FRAMES = 15


class ObjectTracker:
    """
    Manages single object tracking using SAM 2 object segmentation,
    CSRT optical tracking fusion, and Kalman filter smoothing.
    Independent of class labels — tracks the exact visual object selected.
    """

    def __init__(self):
        self.csrt_tracker   = None
        self.is_tracking    = False
        self.target_state   = TargetState.NO_TARGET
        self.label          = "Target"
        self.track_id       = None
        self.kalman         = KalmanFilter2D()

        # Movement buffers and smoothing
        self.previous_center_x = None
        self.current_center_x  = None
        self.center_x_buffer   = []
        self.consecutive_misses = 0
        self.last_dir          = None
        self.target_visible    = False
        self.frame_idx         = 0
        self.last_box          = None
        self.ref_template_hist = None

    # ------------------------------------------------------------------
    # Visual Template Verification (Prevents Target Switching)
    # ------------------------------------------------------------------

    def _extract_template_hist(self, frame, box):
        """Extract normalized 3D HSV color histogram from image patch of box."""
        try:
            h_f, w_f = frame.shape[:2]
            x1 = max(0, min(w_f - 1, int(box[0])))
            y1 = max(0, min(h_f - 1, int(box[1])))
            x2 = max(0, min(w_f - 1, int(box[2])))
            y2 = max(0, min(h_f - 1, int(box[3])))
            if x2 <= x1 or y2 <= y1:
                return None
            patch = frame[y1:y2, x1:x2]
            hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 8, 8], [0, 180, 0, 256, 0, 256])
            cv2.normalize(hist, hist)
            return hist
        except Exception:
            return None

    def _verify_template_similarity(self, frame, candidate_box, threshold=0.35):
        """
        Verifies if candidate_box matches the original selected object's visual appearance.
        Prevents target switching to other objects (bottles, hands, persons, or other phones).
        """
        if self.ref_template_hist is None or candidate_box is None:
            return True  # If no reference, skip filtering

        cand_hist = self._extract_template_hist(frame, candidate_box)
        if cand_hist is None:
            return False

        # Compare color histogram correlation with reference visual template
        sim = cv2.compareHist(self.ref_template_hist, cand_hist, cv2.HISTCMP_CORREL)

        # Correlation >= threshold indicates matching appearance; < threshold rejects target switch
        return sim >= threshold

    # ------------------------------------------------------------------
    # CSRT helper
    # ------------------------------------------------------------------

    def _create_csrt_tracker(self):
        try:
            return cv2.TrackerCSRT_create()
        except AttributeError:
            try:
                return cv2.legacy.TrackerCSRT_create()
            except AttributeError:
                raise RuntimeError(
                    "CSRT Tracker could not be created. Please verify that "
                    "opencv-contrib-python is installed correctly."
                )

    # ------------------------------------------------------------------
    # Geometry helpers
    # ------------------------------------------------------------------

    def _calculate_iou(self, boxA, boxB):
        xA = max(boxA[0], boxB[0]);  yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2]);  yB = min(boxA[3], boxB[3])
        inter_w = max(0, xB - xA);  inter_h = max(0, yB - yA)
        inter   = inter_w * inter_h
        aA = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1])
        aB = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1])
        union = aA + aB - inter
        return inter / float(union) if union > 0 else 0.0

    def _box_distance(self, boxA, boxB):
        cA = ((boxA[0] + boxA[2]) / 2, (boxA[1] + boxA[3]) / 2)
        cB = ((boxB[0] + boxB[2]) / 2, (boxB[1] + boxB[3]) / 2)
        return math.sqrt((cA[0] - cB[0])**2 + (cA[1] - cB[1])**2)

    def _box_center(self, box):
        return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)

    # ------------------------------------------------------------------
    # Initialization
    # ------------------------------------------------------------------

    def init_tracker(self, frame, bbox_xyxy, label="Target", detector=None, track_id=None, point=None, negative_points=None, hand_mask=None):
        """
        Initializes SAM 2 segmentation tracking, CSRT fallback, and 2D Kalman filter.
        Supports point prompts with negative points and hand_mask for complete hand exclusion.
        """
        try:
            x1, y1, x2, y2 = bbox_xyxy
            w = x2 - x1
            h = y2 - y1

            if w <= 0 or h <= 0:
                print("[ERROR] Invalid bounding box size.")
                return False

            self.is_tracking  = True
            self.target_state = TargetState.TARGET_SELECTED
            self.label        = label
            self.frame_idx    = 0
            self.last_box     = [int(x1), int(y1), int(x2), int(y2)]
            self.track_id     = track_id

            # Initial SAM 2 segmentation prompt — prefer point prompt with hand exclusion and ROI constraint
            if detector is not None and hasattr(detector, "segment_sam2"):
                sam_res = None
                if point is not None:
                    sam_res = detector.segment_sam2(
                        frame,
                        bbox=self.last_box,
                        point=point,
                        negative_points=negative_points,
                        hand_mask=hand_mask
                    )
                    if sam_res is not None:
                        print(f"[SAM2] Point prompt ({point[0]}, {point[1]}) → segmented object (ROI constrained, hand excluded)")
                if sam_res is None:
                    # Fallback: bbox prompt with hand_mask
                    sam_res = detector.segment_sam2(frame, bbox=self.last_box, hand_mask=hand_mask)
                # Keep initial full object box (do not shrink to internal point prompt mask)
                pass

            # Store reference visual template of the locked object
            self.ref_template_hist = self._extract_template_hist(frame, self.last_box)

            # Initialize CSRT tracker
            rx1, ry1, rx2, ry2 = self.last_box
            rw, rh = max(1, rx2 - rx1), max(1, ry2 - ry1)
            self.csrt_tracker = self._create_csrt_tracker()
            self.csrt_tracker.init(frame, (int(rx1), int(ry1), int(rw), int(rh)))

            # Initialize 2D Kalman filter
            init_cx = (rx1 + rx2) / 2.0
            init_cy = (ry1 + ry2) / 2.0
            self.kalman.init(init_cx, init_cy)

            self.previous_center_x  = int(init_cx)
            self.current_center_x   = int(init_cx)
            self.center_x_buffer    = [int(init_cx)]
            self.consecutive_misses = 0
            self.last_dir           = None
            self.target_visible     = True
            self.target_state       = TargetState.TARGET_TRACKING

            print(f"[TRACKER] SAM 2 Tracking Started for {label} (ID: {track_id})")
            return True

        except Exception as e:
            print(f"[ERROR] Tracker initialization failed: {e}")
            self.reset()
            return False

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    def update(self, frame, detector=None, precomputed_detections=None, hand_mask=None):
        """
        Updates tracking using SAM 2 object segmentation, CSRT, and Kalman filter.
        Returns (target_visible: bool, bbox_xyxy: list or None).
        """
        if not self.is_tracking:
            return False, None

        self.frame_idx += 1
        sam2_box = None
        csrt_box = None
        csrt_success = False

        # ── 1. CSRT FAST OPTICAL TRACKING ──────────────────────────────────
        if self.csrt_tracker is not None:
            try:
                ok, csrt_bbox_xywh = self.csrt_tracker.update(frame)
                if ok:
                    cx, cy, cw, ch = map(int, csrt_bbox_xywh)
                    if cw > 0 and ch > 0:
                        cand_box = [cx, cy, cx + cw, cy + ch]
                        # Verify candidate against original object's visual template
                        if self._verify_template_similarity(frame, cand_box, threshold=0.35):
                            csrt_box = cand_box
                            csrt_success = True
            except Exception as e:
                print(f"[TRACKER WARNING] CSRT update failed: {e}")

        # ── 2. SAM 2 OBJECT SEGMENTATION ────────────────────────────────────
        prompt_box = csrt_box if csrt_success else self.last_box
        if detector is not None and hasattr(detector, "segment_sam2") and prompt_box is not None:
            sam_res = detector.segment_sam2(frame, bbox=prompt_box, hand_mask=hand_mask)
            if sam_res is not None and sam_res.get("box") is not None:
                cand_sam = sam_res["box"]
                # Verify SAM 2 segmentation candidate against original object's visual template
                if self._verify_template_similarity(frame, cand_sam, threshold=0.35):
                    sam2_box = cand_sam

        # ── 3. DETECTOR TARGET BOX MATCHING ────────────────────────────────
        yolo_box = None
        if precomputed_detections is not None and self.last_box is not None:
            last_cx = (self.last_box[0] + self.last_box[2]) / 2.0
            last_cy = (self.last_box[1] + self.last_box[3]) / 2.0
            if self.track_id is not None:
                for det in precomputed_detections:
                    if det.get("id") == self.track_id:
                        cand_yolo = det["box"]
                        cand_cx = (cand_yolo[0] + cand_yolo[2]) / 2.0
                        cand_cy = (cand_yolo[1] + cand_yolo[3]) / 2.0
                        dist = ((cand_cx - last_cx)**2 + (cand_cy - last_cy)**2) ** 0.5
                        if dist < 120 and self._verify_template_similarity(frame, cand_yolo, threshold=0.45):
                            yolo_box = cand_yolo
                        break
            if yolo_box is None:
                matched_det = self._match_detection_by_proximity(precomputed_detections, frame)
                if matched_det is not None and self._verify_template_similarity(frame, matched_det["box"], threshold=0.45):
                    yolo_box = matched_det["box"]

        # ── 4. RESOLVE TARGET POSITION & KALMAN FUSION ─────────────────────
        resolved_box = None
        if yolo_box is not None:
            resolved_box = yolo_box
        elif csrt_success and csrt_box is not None:
            resolved_box = csrt_box
        elif sam2_box is not None:
            resolved_box = sam2_box
            if self.last_box is not None:
                w_sam = sam2_box[2] - sam2_box[0]
                h_sam = sam2_box[3] - sam2_box[1]
                w_last = self.last_box[2] - self.last_box[0]
                h_last = self.last_box[3] - self.last_box[1]
                if w_sam < w_last * 0.85 or h_sam < h_last * 0.85:
                    sam_cx = (sam2_box[0] + sam2_box[2]) / 2.0
                    sam_cy = (sam2_box[1] + sam2_box[3]) / 2.0
                    target_w = max(w_sam, w_last)
                    target_h = max(h_sam, h_last)
                    resolved_box = [
                        int(sam_cx - target_w / 2.0),
                        int(sam_cy - target_h / 2.0),
                        int(sam_cx + target_w / 2.0),
                        int(sam_cy + target_h / 2.0)
                    ]

        # ── 5. VISIBILITY & RE-ACQUISITION HANDLING ────────────────────────
        if resolved_box is not None:
            # Measurement available
            raw_cx = (resolved_box[0] + resolved_box[2]) / 2.0
            raw_cy = (resolved_box[1] + resolved_box[3]) / 2.0
            kalman_cx, kalman_cy = self.kalman.update(raw_cx, raw_cy)

            # Center box around Kalman smoothed position
            w = resolved_box[2] - resolved_box[0]
            h = resolved_box[3] - resolved_box[1]
            bbox_xyxy = [
                int(kalman_cx - w / 2.0),
                int(kalman_cy - h / 2.0),
                int(kalman_cx + w / 2.0),
                int(kalman_cy + h / 2.0),
            ]

            if not self.target_visible and self.consecutive_misses >= MAX_MISSING_FRAMES:
                print("[TRACKER] Selected object reacquired")
                self.target_state = TargetState.TARGET_REACQUIRING

            self.consecutive_misses = 0
            self.target_visible = True
            self.target_state = TargetState.TARGET_TRACKING
        else:
            # Measurement missing — use Kalman prediction
            kalman_cx, kalman_cy = self.kalman.predict()
            self.consecutive_misses += 1

            if self.last_box is not None:
                w = self.last_box[2] - self.last_box[0]
                h = self.last_box[3] - self.last_box[1]
                bbox_xyxy = [
                    int(kalman_cx - w / 2.0),
                    int(kalman_cy - h / 2.0),
                    int(kalman_cx + w / 2.0),
                    int(kalman_cy + h / 2.0),
                ]
            else:
                bbox_xyxy = None

            if self.consecutive_misses >= MAX_MISSING_FRAMES:
                if self.target_visible:
                    print("[TRACKER] Selected object temporarily lost")
                self.target_visible = False
                self.target_state = TargetState.TARGET_LOST

        # ── 6. EMA SMOOTHING & POSITION BUFFER ──────────────────────────────
        if bbox_xyxy is not None:
            if self.last_box is not None:
                alpha = 0.75 if self.target_visible else 0.40
                bbox_xyxy = [
                    int(alpha * bbox_xyxy[0] + (1 - alpha) * self.last_box[0]),
                    int(alpha * bbox_xyxy[1] + (1 - alpha) * self.last_box[1]),
                    int(alpha * bbox_xyxy[2] + (1 - alpha) * self.last_box[2]),
                    int(alpha * bbox_xyxy[3] + (1 - alpha) * self.last_box[3]),
                ]

            cx = (bbox_xyxy[0] + bbox_xyxy[2]) // 2
            self.previous_center_x = self.current_center_x
            self.current_center_x  = cx
            self.center_x_buffer.append(cx)
            if len(self.center_x_buffer) > 5:
                self.center_x_buffer.pop(0)
            self.last_box = bbox_xyxy

            return self.target_visible, bbox_xyxy
        else:
            return self.target_visible, self.last_box

    # ------------------------------------------------------------------
    # Detection matching helper
    # ------------------------------------------------------------------

    def _match_from_detections(self, detections, frame):
        """
        Backwards-compatible wrapper.
        """
        det = self._match_detection_by_proximity(detections, frame)
        return det["box"] if det is not None else None

    def _match_detection_by_proximity(self, detections, frame):
        """
        Find the detection from the list that best matches self.last_box.
        Uses IoU first; falls back to center distance within 25% of frame diagonal.
        Returns the matched detection dict or None.
        """
        if not detections or self.last_box is None:
            return None

        # Filter to matching label only
        label_lower = self.label.lower().strip()
        candidates  = [
            d for d in detections
            if d["label"].lower().strip() == label_lower
        ]
        if not candidates:
            return None

        h_f, w_f = frame.shape[:2]
        best_iou  = 0.0
        best_dist = float("inf")
        best_det  = None

        for det in candidates:
            iou = self._calculate_iou(self.last_box, det["box"])
            if iou > best_iou:
                best_iou = iou
                best_det = det

        if best_det is None or best_iou < 0.1:
            max_allowed_dist = math.sqrt(w_f**2 + h_f**2) * 0.25
            for det in candidates:
                dist = self._box_distance(self.last_box, det["box"])
                if dist < best_dist and dist < max_allowed_dist:
                    best_dist = dist
                    best_det  = det

        return best_det

    # ------------------------------------------------------------------
    # Movement direction
    # ------------------------------------------------------------------

    def get_movement_direction(self, frame_center_x):
        """
        Calculates movement direction relative to the horizontal center
        reference line with hysteresis to prevent rapid oscillation.
        """
        if not self.center_x_buffer or not getattr(self, "target_visible", True):
            return None

        curr_smoothed     = sum(self.center_x_buffer) / len(self.center_x_buffer)
        trigger_threshold = 35
        release_threshold = 15

        if self.last_dir == "LEFT":
            if curr_smoothed < frame_center_x - release_threshold:
                return "MOVED LEFT"
            else:
                self.last_dir = None
                return None
        elif self.last_dir == "RIGHT":
            if curr_smoothed > frame_center_x + release_threshold:
                return "MOVED RIGHT"
            else:
                self.last_dir = None
                return None
        else:
            if curr_smoothed < frame_center_x - trigger_threshold:
                self.last_dir = "LEFT"
                return "MOVED LEFT"
            elif curr_smoothed > frame_center_x + trigger_threshold:
                self.last_dir = "RIGHT"
                return "MOVED RIGHT"
            return None

    # ------------------------------------------------------------------
    # Reset
    # ------------------------------------------------------------------

    def reset(self):
        self.csrt_tracker       = None
        self.is_tracking        = False
        self.label              = "Target"
        self.track_id           = None
        self.ref_template_hist  = None
        self.previous_center_x  = None
        self.current_center_x   = None
        self.center_x_buffer    = []
        self.last_box           = None
        self.consecutive_misses = 0
        self.last_dir           = None
        self.target_visible     = False
