import cv2
import os
from datetime import datetime


class VideoRecorder:
    """
    Handles webcam recording to MP4 files.
    """

    def __init__(self, output_dir="recordings"):
        self.output_dir = output_dir
        self.writer = None
        self.filename = None
        self._is_recording = False

    @property
    def is_recording(self):
        return self._is_recording

    def start(self, width, height, fps=30.0):
        """
        Start recording.
        """

        if self._is_recording:
            print("[RECORDER] Recording already active.")
            return True

        os.makedirs(self.output_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        self.filename = os.path.join(
            self.output_dir,
            f"recording_{timestamp}.mp4"
        )

        import time
        self.start_time = time.time()
        self.fps = fps
        self.frames_written = 0
        self.last_frame = None

        # H.264 AVC codec for HTML5 web compatibility
        fourcc = cv2.VideoWriter_fourcc(*'avc1')

        print(
            f"[RECORDER] Starting recording:\n"
            f"  File: {self.filename}\n"
            f"  Resolution: {width}x{height}\n"
            f"  FPS: {fps}"
        )

        self.writer = cv2.VideoWriter(
            self.filename,
            fourcc,
            fps,
            (width, height)
        )

        if not self.writer.isOpened():
            print("[RECORDER ERROR] Failed to open VideoWriter.")

            self.writer = None
            self._is_recording = False

            return False

        self._is_recording = True

        return True

    def write(self, frame):
        """
        Write one frame.
        """

        if not self._is_recording:
            return

        if self.writer is None:
            return

        try:
            self.last_frame = frame.copy()
            import time
            current_time = time.time()
            elapsed = current_time - self.start_time

            # Compute how many frames should have been written by now
            target_frames = int(elapsed * self.fps)

            # Determine how many copies of this frame to write to match wall-clock duration
            if self.frames_written == 0:
                num_copies = 1
            else:
                num_copies = target_frames - self.frames_written

            if num_copies > 0:
                for _ in range(num_copies):
                    self.writer.write(frame)
                self.frames_written += num_copies

        except Exception as e:
            print(f"[RECORDER ERROR] Frame write failed: {e}")

    def stop(self):
        """
        Stop recording safely.
        """

        if not self._is_recording:
            return

        print(f"[RECORDER] Stopping recording: {self.filename}")

        import time
        duration = int(time.time() - getattr(self, 'start_time', time.time()))

        # Pad the video to match the final elapsed time before releasing the writer
        try:
            if self.writer is not None and self.start_time is not None and self.last_frame is not None:
                final_elapsed = time.time() - self.start_time
                target_frames = int(final_elapsed * self.fps)
                padding_frames = target_frames - self.frames_written
                if padding_frames > 0:
                    for _ in range(padding_frames):
                        self.writer.write(self.last_frame)
                    self.frames_written += padding_frames
        except Exception as e:
            print(f"[RECORDER ERROR] Padding failed: {e}")

        try:
            if self.writer is not None:
                self.writer.release()

        except Exception as e:
            print(f"[RECORDER ERROR] Release failed: {e}")

        finally:
            self.writer = None
            self._is_recording = False
            self.last_frame = None

        # Write companion JSON metadata
        if self.filename:
            json_filename = self.filename.replace(".mp4", ".json")
            import json
            metadata = {
                "duration": duration,
                "createdAt": int(time.time() * 1000),
                "mode": "AI Control"
            }
            try:
                with open(json_filename, "w") as f:
                    json.dump(metadata, f)
            except Exception as e:
                print(f"[RECORDER ERROR] Failed to write metadata: {e}")

        print("[RECORDER] Recording saved successfully.")

    def cleanup(self):
        """
        Force cleanup on application exit.
        """

        if self._is_recording:
            self.stop()

    def __del__(self):
        """
        Last-resort cleanup.
        """

        try:
            self.cleanup()
        except:
            pass