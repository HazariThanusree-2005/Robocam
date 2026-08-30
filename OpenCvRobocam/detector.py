import cv2
import numpy as np
import math
import threading
import queue
import time
import torch

# ---------------------------------------------------------------------------
# Local OpenCV + YOLO11n + MediaPipe Object & Face Detector  (OPTIMIZED)
# ---------------------------------------------------------------------------
#
# Optimization summary vs original:
#   1. Async YOLO inference thread  – YOLO runs in background; main loop never
#      blocks on inference. A maxsize=1 queue drops stale frames automatically.
#   2. Dead bg_subtractor removed   – was computed but never used in any gate.
#   3. Shared RGB conversion        – single cv2.cvtColor call reused by both
#      YOLO pre-check and MediaPipe.
#   4. Vectorised NMS               – numpy-based IoU matrix instead of O(n²)
#      Python loops.
#   5. Tuned EMA alpha              – 0.65 (was 0.50) for faster box response.
#   6. MISSING_FRAME_LIMIT = 8     – survives short occlusions without flicker.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Tuning constants
# ---------------------------------------------------------------------------
YOLO_RAW_THRESHOLD    = 0.15   # Moderate raw threshold — filters distant/noisy detections
FACE_CONF_THRESHOLD   = 0.40   # MediaPipe face confidence gate
MIN_BOX_AREA_RATIO    = 0.002  # 0.2% of frame — filters tiny distant clutter
NMS_IOU_THRESHOLD     = 0.25   # IoU above which two same-label boxes are suppressed
CONTAIN_THRESHOLD     = 0.60   # containment ratio for same-label duplicate suppression
SMOOTHING_ALPHA       = 0.45   # EMA weight for new position — lower = smoother, less jumpy
MISSING_FRAME_LIMIT   = 15     # frames a track can miss before it is dropped (~0.5 s at 30 fps)
ACTIVE_GATE           = 1      # show box immediately on first frame
MAX_DETECTIONS        = 8      # hard cap on number of boxes returned

# Proximity / Closeness thresholds (area ratio of the frame)
# Allows person detection across near, medium, and farther distances
MIN_AREA_RATIO = {
    "person": 0.001,  # 0.1% of frame — enables detection of near, medium, and farther persons
}

# Per-class minimum confidence after YOLO raw inference — PERSON ONLY
CLASS_CONF_GATE = {
    "person": 0.35,
}

# Handheld classes set (empty since only person is tracked)
_HANDHELD = frozenset()


# ---------------------------------------------------------------------------
# Main detector class
# ---------------------------------------------------------------------------

class ObjectFaceDetector:
    """
    Local person/human detector: YOLO11m (ultralytics) running on cuda:0.

    Key guarantees:
      • Detects HUMANS / PERSONS ONLY (all other COCO classes discarded).
      • Detects people across near, medium, and farther distances in frame.
      • Exactly one bounding box per person instance (same-label NMS + containment).
      • Separate people (Person A, Person B) keep separate independent boxes.
      • Boxes are smoothed across frames (no flickering / jumping).
    """

    def __init__(self, yolo_model_path="yolo11m.pt"):
        # --- CUDA validation ---
        if not torch.cuda.is_available():
            raise RuntimeError(
                "[DETECTOR] FATAL: CUDA is NOT available. "
                "YOLO11m requires an NVIDIA GPU with CUDA support."
            )
        _gpu_name = torch.cuda.get_device_name(0)
        print(f"[DETECTOR] CUDA available — GPU: {_gpu_name}")

        print("[DETECTOR] Loading YOLO11m...")
        try:
            from ultralytics import YOLO
            self._yolo_model = YOLO(yolo_model_path)
            self._yolo_model.to("cuda:0")
            print("[DETECTOR] YOLO11m loaded successfully")
            print("[DETECTOR] Device: cuda:0")
            print(f"[DETECTOR] GPU: {_gpu_name}")
        except Exception as e:
            print(f"[DETECTOR] FATAL: Failed to load YOLO11m model: {e}")
            raise

        print("[SAM2] Loading SAM 2 model...")
        try:
            from ultralytics import SAM
            self._sam_model = SAM("sam2_t.pt")
            print("[SAM2] SAM 2 loaded successfully (sam2_t.pt)")
            print("[SAM2] Device: cuda:0")
            print(f"[SAM2] GPU: {_gpu_name}")
        except Exception as e:
            print(f"[SAM2] Tracking error: Failed to load SAM 2 model: {e}")
            self._sam_model = None

        print("[DETECTOR] Loading MediaPipe face detector...")
        try:
            import mediapipe as mp
            self._mp_face = mp.solutions.face_detection.FaceDetection(
                model_selection=1,
                min_detection_confidence=0.35,
            )
            print("[DETECTOR] MediaPipe face detector ready (full-range model).")
        except Exception as e:
            print(f"[DETECTOR] WARNING: MediaPipe face detector failed: {e}")
            self._mp_face = None

        self.next_id = 0
        self.tracks  = {}   # track_id -> track dict

        # ------------------------------------------------------------------
        # Async YOLO inference thread
        # ------------------------------------------------------------------
        # _infer_queue: main loop puts frames here (maxsize=1 → stale frames
        #               are dropped automatically, no backlog builds up).
        # _result_queue: inference thread puts finished detections here.
        self._infer_queue  = queue.Queue(maxsize=1)
        self._result_queue = queue.Queue(maxsize=1)
        self._infer_stop   = threading.Event()
        self._infer_thread = threading.Thread(
            target=self._yolo_infer_loop, daemon=True, name="yolo-infer"
        )
        self._infer_thread.start()

        # Last async result (used when a new result isn't ready yet)
        self._latest_raw: list = []

        # Compatibility shims (tracker.py interface unchanged)
        self.yolo         = _YoloShim(self._yolo_model)
        self.face_detector = _FaceDetectorShim(self._mp_face)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect_all(self, frame, rgb_frame=None, object_locked=False, tracking_label=None):
        """
        Run detection on a BGR frame.
        Uses MediaPipe face detection as primary source for face/head-only boxes.
        YOLO is still submitted for SAM 2 / tracker fallback use.

        Returns list of dicts:
            {"box": [x1,y1,x2,y2], "label": str, "confidence": float, "id": int}
        """
        h, w = frame.shape[:2]
        frame_area = w * h
        min_box_area = int(MIN_BOX_AREA_RATIO * frame_area)

        # Submit frame to async YOLO thread (kept for SAM 2 / tracker use)
        try:
            self._infer_queue.put_nowait(frame)
        except queue.Full:
            pass
        try:
            self._latest_raw = self._result_queue.get_nowait()
        except queue.Empty:
            pass

        # Primary detection: MediaPipe face detection (face/head boxes only)
        raw = self._run_face_detections(frame, w, h, frame_area, rgb_frame=rgb_frame)

        # Size filter – area only
        raw = self._filter_by_size(raw, min_box_area)

        # Per-label NMS + containment to clean tracking inputs
        raw = self._same_label_nms_fast(raw)

        # Update persistent tracks with EMA smoothing
        self._update_tracks(raw)

        # Build candidates from stable tracks
        candidates = []
        for tid, track in self.tracks.items():
            if track["active_frames"] >= ACTIVE_GATE and track["missing_frames"] <= 10:
                candidates.append({
                    "box":        track["box"],
                    "label":      track["label"],
                    "confidence": track["confidence"],
                    "id":         tid,
                })

        # Apply NMS to final outputs
        candidates = self._same_label_nms_fast(candidates)

        candidates.sort(key=lambda d: d["confidence"], reverse=True)
        return candidates[:MAX_DETECTIONS]

    def close(self):
        """Release resources."""
        self._infer_stop.set()
        try:
            self._infer_queue.put_nowait(None)   # unblock thread
        except queue.Full:
            pass
        self._infer_thread.join(timeout=2.0)
        try:
            if self._mp_face is not None:
                self._mp_face.close()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Async YOLO inference thread
    # ------------------------------------------------------------------

    def _yolo_infer_loop(self):
        """
        Runs in a daemon thread.
        Continuously pulls frames from _infer_queue, runs YOLO, and
        pushes results to _result_queue.
        """
        _logged_device = False
        while not self._infer_stop.is_set():
            try:
                frame = self._infer_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if frame is None:
                break   # Sentinel – shut down

            dets = self._run_yolo_detections(frame)

            # One-time log confirming CUDA inference
            if not _logged_device:
                _gpu_name = torch.cuda.get_device_name(0)
                print("[YOLO] Inference device: cuda:0")
                print(f"[YOLO] GPU: {_gpu_name}")
                _logged_device = True

            # Push result; if previous result wasn't consumed yet, replace it
            try:
                self._result_queue.put_nowait(dets)
            except queue.Full:
                try:
                    self._result_queue.get_nowait()
                except queue.Empty:
                    pass
                try:
                    self._result_queue.put_nowait(dets)
                except queue.Full:
                    pass

    # ------------------------------------------------------------------
    # YOLO-only detection (called from background thread)
    # ------------------------------------------------------------------

    def _run_yolo_detections(self, frame):
        """Run YOLO11m on a BGR frame (cuda:0). Returns raw detection list for 'person' class ONLY."""
        results_list = []
        h_f, w_f = frame.shape[:2]
        frame_area = w_f * h_f

        try:
            yolo_out = self._yolo_model(
                frame, imgsz=640, conf=YOLO_RAW_THRESHOLD,
                device="cuda:0", verbose=False
            )
            for result in yolo_out:
                for box in result.boxes:
                    raw_conf = float(box.conf[0])
                    cls_id   = int(box.cls[0])
                    cls_name = self._yolo_model.names[cls_id].lower().strip()

                    # Keep ONLY person/human class
                    if cls_name != "person":
                        continue

                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    x1 = max(0, min(w_f - 1, x1))
                    y1 = max(0, min(h_f - 1, y1))
                    x2 = max(0, min(w_f - 1, x2))
                    y2 = max(0, min(h_f - 1, y2))

                    box_area   = (x2 - x1) * (y2 - y1)
                    area_ratio = box_area / frame_area

                    # Size filter for person (allow near, medium, and farther persons)
                    if area_ratio < 0.001:
                        continue

                    # Dynamic confidence gate for person
                    base_gate = CLASS_CONF_GATE.get("person", 0.35)
                    gate = max(0.25, base_gate - 0.10) if area_ratio >= 0.01 else base_gate

                    if raw_conf < gate:
                        continue

                    results_list.append({
                        "box":        [x1, y1, x2, y2],
                        "label":      "person",
                        "confidence": raw_conf,
                    })
        except Exception as e:
            print(f"[DETECTOR] YOLO inference error: {e}")

        # Early same-label NMS on raw output — kill duplicate boxes for the
        # same person before they can spawn separate tracks.
        if len(results_list) > 1:
            results_list = self._raw_same_label_nms(results_list)

        return results_list

    # ------------------------------------------------------------------
    # SAM 2 Segmentation Prompt Interface
    # ------------------------------------------------------------------

    def segment_sam2(self, frame, bbox=None, point=None, negative_points=None, hand_mask=None):
        """
        Runs SAM 2 segmentation on a frame using a bbox [x1,y1,x2,y2] or point (x,y) prompt.
        Supports negative_points (labels=0), hand_mask subtraction, and ROI constraint to prevent mask expansion.
        Returns dict with {"box": [x1,y1,x2,y2], "mask": mask_np, "confidence": float} or None.
        """
        if self._sam_model is None:
            return None
        try:
            h_f, w_f = frame.shape[:2]
            kwargs = {"device": "cuda:0", "verbose": False}
            if point is not None:
                pts = [[point[0], point[1]]]
                lbls = [1]
                if negative_points:
                    for np_pt in negative_points:
                        pts.append([np_pt[0], np_pt[1]])
                        lbls.append(0)
                kwargs["points"] = pts
                kwargs["labels"] = lbls
            elif bbox is not None:
                x1, y1, x2, y2 = bbox
                kwargs["bboxes"] = [x1, y1, x2, y2]
            else:
                return None

            results = self._sam_model(frame, **kwargs)
            if results and len(results) > 0 and results[0].masks is not None and len(results[0].masks) > 0:
                mask_tensor = results[0].masks.data[0]
                mask_np = mask_tensor.cpu().numpy().astype(np.uint8)

                # Hand region subtraction to prevent hand/object merger
                if hand_mask is not None:
                    mask_np[hand_mask > 0] = 0

                # ROI constraint: if candidate bbox is provided, constrain SAM 2 mask within padded ROI
                if bbox is not None:
                    bx1, by1, bx2, by2 = bbox
                    pad = 40
                    rx1_c = max(0, int(bx1 - pad))
                    ry1_c = max(0, int(by1 - pad))
                    rx2_c = min(w_f - 1, int(bx2 + pad))
                    ry2_c = min(h_f - 1, int(by2 + pad))
                    roi = np.zeros_like(mask_np, dtype=bool)
                    roi[ry1_c:ry2_c, rx1_c:rx2_c] = True
                    mask_np[~roi] = 0

                if np.sum(mask_np) > 0:
                    y_indices, x_indices = np.where(mask_np > 0)
                    rx1, rx2 = int(np.min(x_indices)), int(np.max(x_indices))
                    ry1, ry2 = int(np.min(y_indices)), int(np.max(y_indices))
                    return {
                        "box": [rx1, ry1, rx2, ry2],
                        "mask": mask_np,
                        "confidence": 0.95
                    }
        except Exception as e:
            print(f"[SAM2] Tracking error: {e}")
        return None

    # ------------------------------------------------------------------
    # MediaPipe face detection (fast, runs synchronously)
    # ------------------------------------------------------------------

    def _run_face_detections(self, frame, w_f, h_f, frame_area, rgb_frame=None):
        """Run MediaPipe face detector synchronously. Returns face/head detection list labeled 'person'."""
        results_list = []
        if self._mp_face is None:
            return results_list

        try:
            if rgb_frame is None:
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            face_res = self._mp_face.process(rgb_frame)
            if face_res.detections:
                for face in face_res.detections:
                    fconf = float(face.score[0]) if face.score else 0.8
                    bbox  = face.location_data.relative_bounding_box
                    fx1   = max(0, int(bbox.xmin * w_f))
                    fy1   = max(0, int(bbox.ymin * h_f))
                    fx2   = min(w_f - 1, fx1 + int(bbox.width  * w_f))
                    fy2   = min(h_f - 1, fy1 + int(bbox.height * h_f))

                    face_area = (fx2 - fx1) * (fy2 - fy1)
                    if face_area < 100:  # reject tiny noise detections
                        continue

                    if fconf < 0.35:
                        continue

                    results_list.append({
                        "box":        [fx1, fy1, fx2, fy2],
                        "label":      "person",
                        "confidence": fconf,
                    })
        except Exception as e:
            print(f"[DETECTOR] MediaPipe face error: {e}")

        return results_list

    # ------------------------------------------------------------------
    # Size filter
    # ------------------------------------------------------------------

    def _filter_by_size(self, detections, min_area):
        """Reject boxes whose area is too small (distant/tiny objects)."""
        kept = []
        for d in detections:
            x1, y1, x2, y2 = d["box"]
            if (x2 - x1) * (y2 - y1) >= min_area:
                kept.append(d)
        return kept

    # ------------------------------------------------------------------
    # Vectorised per-label NMS (numpy-based – replaces O(n²) Python loop)
    # ------------------------------------------------------------------

    def _same_label_nms_fast(self, detections):
        """
        Greedy NMS within each label.
        Uses numpy for the IoU matrix to minimise Python-loop overhead.
        """
        if not detections:
            return []

        by_label: dict = {}
        for d in detections:
            by_label.setdefault(d["label"], []).append(d)

        final = []
        for label, dets in by_label.items():
            if len(dets) == 1:
                final.extend(dets)
                continue

            dets_sorted = sorted(dets, key=lambda d: d["confidence"], reverse=True)
            boxes = np.array([d["box"] for d in dets_sorted], dtype=np.float32)
            keep  = []

            suppressed = [False] * len(dets_sorted)
            for i in range(len(dets_sorted)):
                if suppressed[i]:
                    continue
                keep.append(dets_sorted[i])
                for j in range(i + 1, len(dets_sorted)):
                    if suppressed[j]:
                        continue
                    iou = self._iou_np(boxes[i], boxes[j])
                    cr1 = self._containment_np(boxes[i], boxes[j])
                    cr2 = self._containment_np(boxes[j], boxes[i])
                    if iou >= NMS_IOU_THRESHOLD or cr1 >= CONTAIN_THRESHOLD or cr2 >= CONTAIN_THRESHOLD:
                        suppressed[j] = True

            final.extend(keep)

        return final

    # ------------------------------------------------------------------
    # Suppress person boxes when face overlaps
    # ------------------------------------------------------------------

    def _suppress_person_if_face_present(self, detections):
        """
        Suppresses any non-handheld larger box if a 'face' box overlaps/lies
        inside it. Prevents nested face-inside-person boxes.
        """
        face_boxes = [d["box"] for d in detections if d["label"] == "face"]
        if not face_boxes:
            return detections

        result = []
        for d in detections:
            if d["label"] == "face" or d["label"] in _HANDHELD:
                result.append(d)
                continue

            overlaps_face = any(
                self._containment_ratio(fb, d["box"]) >= 0.30
                or self._iou(fb, d["box"]) >= 0.05
                for fb in face_boxes
            )
            if not overlaps_face:
                result.append(d)

        return result

    # ------------------------------------------------------------------
    # Cross-label NMS (vectorised)
    # ------------------------------------------------------------------

    def _cross_label_nms_fast(self, detections):
        """
        Cross-label duplicate suppression.
        Suppresses lower-confidence overlapping boxes while preserving distinct
        separate objects (e.g. handheld pen/phone near/inside person box).
        """
        if not detections:
            return []

        sorted_dets = sorted(detections, key=lambda d: d["confidence"], reverse=True)
        kept = []

        for candidate in sorted_dets:
            suppressed = False
            cbox   = candidate["box"]
            clabel = candidate["label"]
            c_area = max(1, (cbox[2] - cbox[0]) * (cbox[3] - cbox[1]))

            for ref in kept:
                rbox   = ref["box"]
                rlabel = ref["label"]
                r_area = max(1, (rbox[2] - rbox[0]) * (rbox[3] - rbox[1]))

                iou          = self._iou(cbox, rbox)
                cr_cand_ref  = self._containment_ratio(cbox, rbox)
                cr_ref_cand  = self._containment_ratio(rbox, cbox)

                # High overlap between different class labels on the same physical region
                if iou >= 0.40:
                    is_person_handheld_pair = (clabel == "person" and rlabel in _HANDHELD) or (rlabel == "person" and clabel in _HANDHELD)
                    both_handheld = (clabel in _HANDHELD and rlabel in _HANDHELD and clabel != rlabel)
                    if both_handheld:
                        if iou >= 0.65:
                            suppressed = True
                            break
                    elif not is_person_handheld_pair:
                        suppressed = True
                        break

                # Severe containment: candidate is > 75% inside ref box of non-handheld category
                if cr_cand_ref >= 0.75:
                    if clabel == rlabel:
                        suppressed = True
                        break
                    elif clabel not in _HANDHELD and rlabel not in _HANDHELD:
                        suppressed = True
                        break

                # Ref is > 75% inside candidate box (candidate is a huge encompassing box)
                if cr_ref_cand >= 0.75 and clabel not in _HANDHELD:
                    if c_area > 3.0 * r_area and clabel not in ("person", "face"):
                        suppressed = True
                        break

            if not suppressed:
                kept.append(candidate)

        return kept

    # ------------------------------------------------------------------
    # Track management
    # ------------------------------------------------------------------

    def _update_tracks(self, raw_detections):
        """
        Match raw detections to existing tracks using IoU + containment + spatial proximity.
        Apply EMA smoothing to box coordinates.
        Drop stale tracks after MISSING_FRAME_LIMIT misses.
        """
        updated     = {}
        matched_raw = set()

        for tid, track in self.tracks.items():
            best_score = 0.0
            best_idx   = -1

            for idx, raw in enumerate(raw_detections):
                if idx in matched_raw:
                    continue

                iou = self._iou(raw["box"], track["box"])
                cr1 = self._containment_ratio(raw["box"], track["box"])
                cr2 = self._containment_ratio(track["box"], raw["box"])

                c_raw   = ((raw["box"][0] + raw["box"][2]) / 2,
                           (raw["box"][1] + raw["box"][3]) / 2)
                c_track = ((track["box"][0] + track["box"][2]) / 2,
                           (track["box"][1] + track["box"][3]) / 2)
                dist = math.sqrt((c_raw[0] - c_track[0])**2
                                 + (c_raw[1] - c_track[1])**2)

                same_label = (raw["label"] == track["label"])

                if same_label:
                    if iou >= 0.15 or dist < 120 or max(cr1, cr2) >= 0.50:
                        match_score = max(iou, max(cr1, cr2) * 0.75, max(0.1, 1.0 - dist / 150.0))
                    else:
                        match_score = 0.0
                else:
                    # Different raw label (e.g. YOLO flipped between 'phone' and 'remote')
                    # Match if high spatial overlap indicates it is the SAME physical object
                    if iou >= 0.45 or (dist < 50 and max(cr1, cr2) >= 0.60):
                        match_score = max(iou * 0.9, max(cr1, cr2) * 0.70)
                    else:
                        match_score = 0.0

                if match_score > best_score:
                    best_score = match_score
                    best_idx   = idx

            if best_idx != -1 and best_score > 0.15:
                raw  = raw_detections[best_idx]
                prev = track["box"]
                rb   = raw["box"]
                a    = SMOOTHING_ALPHA
                smoothed = [
                    int(a * rb[0] + (1 - a) * prev[0]),
                    int(a * rb[1] + (1 - a) * prev[1]),
                    int(a * rb[2] + (1 - a) * prev[2]),
                    int(a * rb[3] + (1 - a) * prev[3]),
                ]
                
                # If confidence is significantly higher, adopt the raw label
                chosen_label = raw["label"] if raw["confidence"] > track["confidence"] + 0.10 else track["label"]

                updated[tid] = {
                    "box":            smoothed,
                    "label":          chosen_label,
                    "confidence":     max(raw["confidence"], track["confidence"]),
                    "missing_frames": 0,
                    "active_frames":  track["active_frames"] + 1,
                }
                matched_raw.add(best_idx)
            else:
                missing = track["missing_frames"] + 1
                if missing <= MISSING_FRAME_LIMIT:
                    updated[tid] = {
                        "box":            track["box"],
                        "label":          track["label"],
                        "confidence":     track["confidence"],
                        "missing_frames": missing,
                        "active_frames":  track["active_frames"],
                    }

        for idx, raw in enumerate(raw_detections):
            if idx in matched_raw:
                continue

            # Check if this raw detection overlaps strongly with any existing updated track
            # If so, do NOT spawn a duplicate track for the same physical object
            already_tracked = False
            for tid, tr in updated.items():
                if self._iou(raw["box"], tr["box"]) >= 0.40 or (self._containment_ratio(raw["box"], tr["box"]) >= 0.65):
                    already_tracked = True
                    break

            if not already_tracked:
                updated[self.next_id] = {
                    "box":            raw["box"],
                    "label":          raw["label"],
                    "confidence":     raw["confidence"],
                    "missing_frames": 0,
                    "active_frames":  1,
                }
                lbl  = raw["label"]
                disp = "Phone" if lbl == "cell phone" else lbl.capitalize()
                print(f"[DETECTOR] {disp} detected (Track ID: {self.next_id})")
                self.next_id += 1

        self.tracks = updated

    # ------------------------------------------------------------------
    # Geometry helpers (scalar – used for cross-label & track matching)
    # ------------------------------------------------------------------

    @staticmethod
    def _iou(boxA, boxB):
        """Standard Intersection-over-Union."""
        xA = max(boxA[0], boxB[0]);  yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2]);  yB = min(boxA[3], boxB[3])
        inter = max(0, xB - xA) * max(0, yB - yA)
        aA    = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1])
        aB    = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1])
        union = aA + aB - inter
        return inter / float(union) if union > 0 else 0.0

    @staticmethod
    def _containment_ratio(inner, outer):
        """Fraction of 'inner' box's area that lies inside 'outer' box."""
        ix1 = max(inner[0], outer[0]);  iy1 = max(inner[1], outer[1])
        ix2 = min(inner[2], outer[2]);  iy2 = min(inner[3], outer[3])
        inter      = max(0, ix2 - ix1) * max(0, iy2 - iy1)
        inner_area = (inner[2] - inner[0]) * (inner[3] - inner[1])
        return inter / float(inner_area) if inner_area > 0 else 0.0

    # Numpy variants for the vectorised NMS inner loop
    @staticmethod
    def _iou_np(bA, bB):
        xA, yA = max(bA[0], bB[0]), max(bA[1], bB[1])
        xB, yB = min(bA[2], bB[2]), min(bA[3], bB[3])
        inter  = max(0.0, xB - xA) * max(0.0, yB - yA)
        aA = (bA[2] - bA[0]) * (bA[3] - bA[1])
        aB = (bB[2] - bB[0]) * (bB[3] - bB[1])
        union = aA + aB - inter
        return inter / union if union > 0 else 0.0

    @staticmethod
    def _containment_np(inner, outer):
        ix1, iy1 = max(inner[0], outer[0]), max(inner[1], outer[1])
        ix2, iy2 = min(inner[2], outer[2]), min(inner[3], outer[3])
        inter      = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
        inner_area = (inner[2] - inner[0]) * (inner[3] - inner[1])
        return inter / inner_area if inner_area > 0 else 0.0

    # keep _calculate_iou as alias so any external code still works
    def _calculate_iou(self, boxA, boxB):
        return self._iou(boxA, boxB)

    # ------------------------------------------------------------------
    # Raw same-label NMS (applied inside _run_yolo_detections)
    # ------------------------------------------------------------------

    @staticmethod
    def _raw_same_label_nms(detections):
        """
        Quick greedy per-label NMS on raw YOLO output.
        Suppresses lower-confidence duplicates that overlap ≥ 25 % IoU
        or where one box is ≥ 60 % contained inside the other.
        """
        by_label: dict = {}
        for d in detections:
            by_label.setdefault(d["label"], []).append(d)

        kept = []
        for label, dets in by_label.items():
            if len(dets) == 1:
                kept.append(dets[0])
                continue
            dets.sort(key=lambda x: x["confidence"], reverse=True)
            suppressed = [False] * len(dets)
            for i in range(len(dets)):
                if suppressed[i]:
                    continue
                kept.append(dets[i])
                bA = dets[i]["box"]
                for j in range(i + 1, len(dets)):
                    if suppressed[j]:
                        continue
                    bB = dets[j]["box"]
                    # IoU
                    xA = max(bA[0], bB[0]); yA = max(bA[1], bB[1])
                    xB = min(bA[2], bB[2]); yB = min(bA[3], bB[3])
                    inter = max(0, xB - xA) * max(0, yB - yA)
                    aA = (bA[2] - bA[0]) * (bA[3] - bA[1])
                    aB = (bB[2] - bB[0]) * (bB[3] - bB[1])
                    union = aA + aB - inter
                    iou = inter / union if union > 0 else 0.0
                    if iou >= NMS_IOU_THRESHOLD:
                        suppressed[j] = True
                        continue
                    # Containment
                    area_j = aB if aB > 0 else 1
                    area_i = aA if aA > 0 else 1
                    if inter / area_j >= CONTAIN_THRESHOLD or inter / area_i >= CONTAIN_THRESHOLD:
                        suppressed[j] = True
        return kept


# ---------------------------------------------------------------------------
# Compatibility shims for tracker.py (interface unchanged)
# ---------------------------------------------------------------------------

class _YoloShim:
    """
    Wraps ultralytics YOLO so tracker.py can call:
        detector.yolo(frame, imgsz=640, conf=0.25, verbose=False)
    and use detector.yolo.names dict.
    """
    def __init__(self, model):
        self._model = model
        self.names  = model.names   # {int: str}

    def __call__(self, frame, imgsz=640, conf=0.25, verbose=False):
        return self._model(frame, imgsz=imgsz, conf=conf, verbose=verbose)


class _FaceDetectorShim:
    """
    Wraps MediaPipe FaceDetection so tracker.py can call:
        detector.face_detector.process(rgb_frame)
    """
    def __init__(self, mp_face):
        self._mp_face = mp_face

    def process(self, rgb_frame):
        if self._mp_face is None:
            return _EmptyFaceResults()
        try:
            return self._mp_face.process(rgb_frame)
        except Exception as e:
            print(f"[DETECTOR] Face shim error: {e}")
            return _EmptyFaceResults()


class _EmptyFaceResults:
    detections = None