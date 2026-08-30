import time
import math


class ObjectSelector:
    """
    Manages selecting an object by hovering the index fingertip inside a bounding box
    continuously for 2 seconds.
    """
    def __init__(self, tap_window=0.8):
        self.hovered_target_id = None  # ID of the box being hovered
        self.hover_start_time = None   # Timestamp when the hover started
        self.last_seen_time = None     # Timestamp of last valid hover detection
        self.hovered_box = None        # Bounding box of currently hovered target
        self.locked_object = None      # dict of the locked detection

    def _get_box_area(self, box):
        return (box[2] - box[0]) * (box[3] - box[1])

    def update(self, detections, fingertips, frame_area=None, hand_landmarks=None):
        """
        Updates selection state.
        Args:
            detections: list of dicts with {"box": [x1, y1, x2, y2], "label": str, "id": int, ...}
            fingertips: list of (x, y) tuples from detected hands, or empty list
            frame_area: total area of the frame (w * h) in pixels
            hand_landmarks: MediaPipe hand landmarks or None
        Returns:
            (selected_detection_dict or None, tap_count, is_locked)
        """
        current_time = time.time()
        
        # 1. If no fingertip is tracked, reset hover and return early
        if not fingertips:
            self.reset_hover()
            return None, 0, False

        # 2. Find candidate detection under index fingertip
        HANDHELD_ITEMS = {"cell phone", "bottle", "cup", "remote", "mouse", "book", "headphones", "wallet", "pen", "pencil", "scissors", "object"}
        best_det = None

        # Requirement 7: If currently hovering a target, check if fingertip is STILL on that target
        if self.hovered_target_id is not None and self.hovered_box is not None:
            # Check if any detection matching hovered_target_id contains the fingertip
            for det in detections:
                if det.get("id") == self.hovered_target_id:
                    x1, y1, x2, y2 = det["box"]
                    padding = 25
                    px1, py1, px2, py2 = x1 - padding, y1 - padding, x2 + padding, y2 + padding
                    for fx, fy in fingertips:
                        if px1 <= fx <= px2 and py1 <= fy <= py2:
                            best_det = dict(det)
                            best_det["point"] = (fx, fy)
                            break
                    if best_det is not None:
                        break

        # If not already hovering or current target not matched, search all detections
        if best_det is None:
            min_score = float('inf')
            for det in detections:
                x1, y1, x2, y2 = det["box"]
                padding = 20
                px1, py1, px2, py2 = x1 - padding, y1 - padding, x2 + padding, y2 + padding
                for fx, fy in fingertips:
                    if px1 <= fx <= px2 and py1 <= fy <= py2:
                        area = self._get_box_area(det["box"])
                        priority = 0.001 if det.get("label", "").lower() in HANDHELD_ITEMS else 1.0
                        score = area * priority
                        if score < min_score:
                            min_score = score
                            best_det = dict(det)
                            best_det["point"] = (fx, fy)

        # 3. Handle 2-second continuous hold timer with transient drop grace period
        if best_det is not None:
            box_id = best_det.get("id", f"box_{best_det['box'][0]}_{best_det['box'][1]}")
            if self.hovered_target_id != box_id:
                # Started hovering a new object
                self.hovered_target_id = box_id
                self.hover_start_time = current_time
                self.last_seen_time = current_time
                self.hovered_box = best_det["box"]
            else:
                # Still hovering same object
                self.last_seen_time = current_time
                self.hovered_box = best_det["box"]
                elapsed = current_time - self.hover_start_time
                if elapsed >= 2.0:
                    print(f"[SELECTOR] Object Locked (2.0s hold completed): {best_det['label']} (ID: {box_id})")
                    self.locked_object = best_det
                    self.reset_hover()
                    return best_det, 0, True
        else:
            # Fingertip briefly slipped or detection momentarily missed
            # Grace period: allow up to 0.3s (9-10 frames) drop before resetting hover timer
            if self.last_seen_time is not None and (current_time - self.last_seen_time) <= 0.30:
                pass  # Keep hover_start_time active during transient drop
            else:
                self.reset_hover()

        return best_det, 0, False

    def reset_hover(self):
        """Resets the hover state (called when finger leaves or lock transitions)."""
        self.hovered_target_id = None
        self.hover_start_time = None
        self.last_seen_time = None
        self.hovered_box = None

    def reset_lock(self):
        """Resets both hover and lock state."""
        self.reset_hover()
        self.locked_object = None
