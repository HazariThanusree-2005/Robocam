import time
import math
import collections

# ---------------------------------------------------------------------------
# GestureController — Sliding-Window Temporal Smoothing State Machine
# (unchanged logic, added extensive debug logging)
# ---------------------------------------------------------------------------

WINDOW_SIZE = 10
FIST_THRESHOLD = 5
OPEN_THRESHOLD = 5
COOLDOWN_SECONDS = 1.5

RELEASE_THRESHOLD = 3
MAX_EXTENDED_FOR_FIST = 0


class GestureController:
    STATE_WAIT_RELEASE = "WAIT_RELEASE"
    STATE_READY = "READY"

    def __init__(self):
        self._state = {"Left": self.STATE_READY, "Right": self.STATE_READY}
        self._window = {"Left": collections.deque(maxlen=WINDOW_SIZE),
                        "Right": collections.deque(maxlen=WINDOW_SIZE)}
        self._last_trigger_time = 0.0
        self._last_detect_time = {"Left": 0.0, "Right": 0.0}
        self._logged_hand = False

    @staticmethod
    def _count_extended(landmarks):
        w = landmarks[0]
        def dist3d(a, b):
            return math.sqrt((a.x - b.x)**2 + (a.y - b.y)**2 + (a.z - b.z)**2)
        def is_ext(tip_idx, pip_idx):
            return dist3d(landmarks[tip_idx], w) > dist3d(landmarks[pip_idx], w)
        extended = 0
        for tip, pip in [(8, 6), (12, 10), (16, 14), (20, 18)]:
            if is_ext(tip, pip):
                extended += 1
        return extended

    @staticmethod
    def _is_thumb_folded(landmarks):
        """
        True when the thumb is curled inward (closed-fist position).
        Checks that thumb tip (4) is folded toward wrist (0) or palm (middle MCP 9).
        """
        w = landmarks[0]
        def dist3d(a, b):
            return math.sqrt((a.x - b.x)**2 + (a.y - b.y)**2 + (a.z - b.z)**2)
        thumb_tip_w = dist3d(landmarks[4], w)
        thumb_ip_w  = dist3d(landmarks[3], w)
        thumb_tip_mcp9 = dist3d(landmarks[4], landmarks[9])
        cmc_mcp9 = dist3d(landmarks[1], landmarks[9])
        
        return (thumb_tip_w <= thumb_ip_w * 1.08) or (thumb_tip_mcp9 <= cmc_mcp9 * 1.35)

    def update(self, hand_results_or_landmarks, is_recording=False):
        print("[GESTURE] update()")
        rec_str = "ON" if is_recording else "OFF"
        print(f"[GESTURE] Recording State = {rec_str}")
        now = time.time()
        multi_hand_landmarks = None
        multi_handedness = None
        if hand_results_or_landmarks is not None:
            if hasattr(hand_results_or_landmarks, "multi_hand_landmarks"):
                multi_hand_landmarks = hand_results_or_landmarks.multi_hand_landmarks
                multi_handedness = getattr(hand_results_or_landmarks, "multi_handedness", None)
            elif isinstance(hand_results_or_landmarks, list):
                multi_hand_landmarks = hand_results_or_landmarks

        has_hand = bool(multi_hand_landmarks)
        if has_hand:
            if not self._logged_hand:
                self._logged_hand = True
        else:
            self._logged_hand = False

        any_fist = False
        if has_hand:
            for hand_lm in multi_hand_landmarks:
                count = self._count_extended(hand_lm.landmark)
                thumb_folded = self._is_thumb_folded(hand_lm.landmark)
                if count <= MAX_EXTENDED_FOR_FIST and thumb_folded:
                    any_fist = True

        if any_fist:
            print("[GESTURE] Closed Fist = TRUE")
            print("[GESTURE] Closed Fist Detected")
        else:
            print("[GESTURE] Closed Fist = FALSE")

        if not has_hand:
            for label in ("Left", "Right"):
                self._window[label].append("OTHER")
                if now - self._last_detect_time[label] > 0.5:
                    if self._state[label] != self.STATE_READY:
                        print("[GESTURE] Hand Released")
                        self._state[label] = self.STATE_READY
            for label in ("Left", "Right"):
                print(f"[GESTURE] Current State = {self._state[label]}")
            return None

        if (now - self._last_trigger_time) < COOLDOWN_SECONDS:
            for label in ("Left", "Right"):
                self._window[label].append("OTHER")
            for label in ("Left", "Right"):
                print(f"[GESTURE] Current State = {self._state[label]}")
            return None

        active_labels = set()
        trigger_action = None

        for i, hand_lm in enumerate(multi_hand_landmarks):
            hand_label = "Left" if i == 0 else "Right"
            if multi_handedness and i < len(multi_handedness):
                try:
                    raw_label = multi_handedness[i].classification[0].label
                    if raw_label.lower() == "left" or raw_label.startswith("L"):
                        hand_label = "Left"
                    else:
                        hand_label = "Right"
                except Exception:
                    pass

            active_labels.add(hand_label)
            self._last_detect_time[hand_label] = now
            count = self._count_extended(hand_lm.landmark)
            thumb_folded = self._is_thumb_folded(hand_lm.landmark)
            if count <= MAX_EXTENDED_FOR_FIST and thumb_folded:
                posture = "FIST"
            elif count >= RELEASE_THRESHOLD:
                posture = "OPEN"
            else:
                posture = "OTHER"

            self._window[hand_label].append(posture)
            fist_count = self._window[hand_label].count("FIST")
            state = self._state[hand_label]

            if state == self.STATE_WAIT_RELEASE:
                non_fist_count = len(self._window[hand_label]) - fist_count
                if non_fist_count >= OPEN_THRESHOLD:
                    self._state[hand_label] = self.STATE_READY
                    print("[GESTURE] Hand Released")
                    print(f"[GESTURE] {hand_label} hand release confirmed "
                          f"({non_fist_count}/{WINDOW_SIZE} non-fist frames). State → READY")
            elif state == self.STATE_READY:
                if fist_count >= FIST_THRESHOLD:
                    self._last_trigger_time = now
                    for label in ("Left", "Right"):
                        self._window[label].clear()
                        self._state[label] = self.STATE_WAIT_RELEASE

                    if not is_recording:
                        trigger_action = "START"
                    else:
                        trigger_action = "STOP"

        for label in ("Left", "Right"):
            if label not in active_labels:
                self._window[label].append("OTHER")
                if now - self._last_detect_time[label] > 0.5:
                    if self._state[label] != self.STATE_READY:
                        print("[GESTURE] Hand Released")
                        self._state[label] = self.STATE_READY

        if trigger_action == "START":
            print("START")
            print("[GESTURE] Returning START")
            return "START"
        elif trigger_action == "STOP":
            print("STOP")
            print("[GESTURE] Returning STOP")
            return "STOP"
        else:
            for label in ("Left", "Right"):
                print(f"[GESTURE] Current State = {self._state[label]}")
            return None

    def reset_gesture(self):
        self._last_trigger_time = 0.0
        self._logged_hand = False
        for label in ("Left", "Right"):
            self._window[label].clear()
            self._state[label] = self.STATE_READY
            self._last_detect_time[label] = 0.0
