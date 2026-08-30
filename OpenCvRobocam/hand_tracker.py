import cv2

import mediapipe as mp
hands = mp.solutions.hands
drawing_utils = mp.solutions.drawing_utils
drawing_styles = mp.solutions.drawing_styles


class HandTracker:
    """
    MediaPipe Hand Tracking Wrapper
    """

    def __init__(
        self,
        max_num_hands=2,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    ):

        print("[HAND TRACKER] Initializing MediaPipe Hands...")

        self.hands_module = hands

        self.hands = hands.Hands(
            static_image_mode=False,
            max_num_hands=max_num_hands,
            model_complexity=0,   # 0 = lite model (~30% faster; sufficient for fingertip tracking)
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence
        )

        self.mp_draw = drawing_utils
        self.mp_drawing_styles = drawing_styles

    def process(self, frame, rgb_frame=None):
        if rgb_frame is None:
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        results = self.hands.process(rgb_frame)

        return results

    def get_index_fingertip(self, hand_landmarks, width, height):

        tip = hand_landmarks.landmark[
            self.hands_module.HandLandmark.INDEX_FINGER_TIP
        ]

        x = int(tip.x * width)
        y = int(tip.y * height)

        x = max(0, min(width - 1, x))
        y = max(0, min(height - 1, y))

        return x, y

    def get_hand_exclusion_points(self, hand_landmarks, width, height):
        """
        Returns list of (x, y) coordinates for key hand joints (wrist, MCP, PIP, palm)
        to pass as negative prompt points (labels=0) to SAM 2 for hand exclusion.
        """
        exclude_indices = [0, 5, 6, 9, 10, 12, 14, 16, 18, 20]
        points = []
        for idx in exclude_indices:
            lm = hand_landmarks.landmark[idx]
            px = max(0, min(width - 1, int(lm.x * width)))
            py = max(0, min(height - 1, int(lm.y * height)))
            points.append((px, py))
        return points

    def get_hand_mask(self, hand_landmarks, width, height):
        """
        Creates a binary mask (uint8 0/255) covering the hand region
        so hand pixels can be subtracted from SAM 2 masks to prevent hand contamination.
        """
        import numpy as np
        mask = np.zeros((height, width), dtype=np.uint8)
        pts = []
        for lm in hand_landmarks.landmark:
            px = max(0, min(width - 1, int(lm.x * width)))
            py = max(0, min(height - 1, int(lm.y * height)))
            pts.append([px, py])
        if pts:
            pts_np = np.array(pts, dtype=np.int32)
            hull = cv2.convexHull(pts_np)
            cv2.fillConvexPoly(mask, hull, 255)
            # Dilate slightly to cover finger boundary
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
            mask = cv2.dilate(mask, kernel)
        return mask

    def is_pointing_gesture(self, hand_landmarks):
        """
        Returns True ONLY when the index finger is fully extended
        and ALL other fingers (middle, ring, pinky) are folded.

        This is the intentional pointing gesture that activates the
        yellow selection dot. Holding a phone, pen, or just resting
        the hand will NOT satisfy this check.

        Thumb state is intentionally ignored (neutral) because thumb
        position varies widely during natural pointing.

        Landmark indices used (MediaPipe Hands):
          Wrist  = 0
          Index  tip=8  pip=6
          Middle tip=12 pip=10
          Ring   tip=16 pip=14
          Pinky  tip=20 pip=18
        """
        import math

        lm = hand_landmarks.landmark
        wrist = lm[0]

        def dist3d(a, b):
            return math.sqrt(
                (a.x - b.x) ** 2 +
                (a.y - b.y) ** 2 +
                (a.z - b.z) ** 2
            )

        def is_extended(tip_idx, pip_idx):
            """Tip is farther from wrist than PIP → finger is extended."""
            return dist3d(lm[tip_idx], wrist) > dist3d(lm[pip_idx], wrist)

        index_up  = is_extended(8, 6)
        middle_up = is_extended(12, 10)
        ring_up   = is_extended(16, 14)
        pinky_up  = is_extended(20, 18)

        # Strict: index must be up, ALL others must be down
        return index_up and (not middle_up) and (not ring_up) and (not pinky_up)

    def draw_landmarks(self, frame, hand_landmarks):

        self.mp_draw.draw_landmarks(
            frame,
            hand_landmarks,
            self.hands_module.HAND_CONNECTIONS,
            self.mp_drawing_styles.get_default_hand_landmarks_style(),
            self.mp_drawing_styles.get_default_hand_connections_style()
        )

    def close(self):
        self.hands.close()