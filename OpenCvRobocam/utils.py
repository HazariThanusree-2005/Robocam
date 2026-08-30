import cv2
import urllib.request
import threading

# Variable to keep track of the last sent direction
_last_direction = None
esp32_ip = None

def _send_request_async(url):
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=0.5) as response:
            response.read()
    except Exception as e:
        # Silently fail if target is unreachable (prevent flood in terminal)
        pass

def send_direction(direction: str):
    """
    Sends the direction command to external hardware or robotics systems.
    Prints the direction on every call (continuous stream).
    """
    global _last_direction, esp32_ip
    print(direction)
    _last_direction = direction

    # ESP32 request is now handled directly by the frontend browser console layer.
    # We only output/print the direction to stdout so the node server propagates it via SSE.
    pass

def reset_direction():
    """Resets the last sent direction state."""
    global _last_direction
    _last_direction = None

def draw_direction_overlay(frame, direction_status: str):
    """
    Draws MOVED LEFT or MOVED RIGHT on the screen.
    Only draws when there is an active movement direction.
    """
    if direction_status not in ("MOVED LEFT", "MOVED RIGHT"):
        return

    h, w, _ = frame.shape
    COLOR_GREEN = (0, 255, 0)

    # Draw direction text in the top-right area
    text_x = w - 250
    cv2.putText(frame, direction_status, (text_x, 50),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, COLOR_GREEN, 3, cv2.LINE_AA)
