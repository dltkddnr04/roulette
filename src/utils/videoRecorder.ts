import { pad } from './utils';

const RECORDING_MIME_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

export class VideoRecorder {
  private targetCanvas: HTMLCanvasElement;
  private mediaRecorder: MediaRecorder | null = null;
  private videoStream: MediaStream | null = null;
  private mimeType = 'video/webm';

  private chunks: Blob[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.targetCanvas = canvas;
    if (typeof MediaRecorder === 'undefined' || typeof this.targetCanvas.captureStream !== 'function') return;

    try {
      const stream = this.targetCanvas.captureStream();
      this.videoStream = stream;
      const supportedMimeType = RECORDING_MIME_TYPES.find(
        (mimeType) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mimeType)
      );
      const recorderOptions: MediaRecorderOptions = {
        videoBitsPerSecond: 6000000,
      };
      if (supportedMimeType) recorderOptions.mimeType = supportedMimeType;

      this.mediaRecorder = new MediaRecorder(stream, recorderOptions);
      this.mimeType = this.mediaRecorder.mimeType || supportedMimeType || this.mimeType;
    } catch (e) {
      console.warn('Video recording is unavailable', e);
      this.videoStream?.getTracks().forEach((track) => track.stop());
      this.videoStream = null;
    }
  }

  public get isRecording() {
    return this.mediaRecorder?.state === 'recording';
  }

  public async start() {
    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error('Video recording is not supported');
    if (this.isRecording) return;
    return new Promise<void>((resolve, reject) => {
      this.chunks = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || this.mimeType;
        const container = mimeType.split(';', 1)[0].toLowerCase();
        const extension = container === 'video/mp4' ? 'mp4' : container === 'video/ogg' ? 'ogv' : 'webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        const videoUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        const d = new Date();

        downloadLink.href = videoUrl;
        downloadLink.download = `marble_roulette_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${extension}`;
        downloadLink.click();
        downloadLink.remove();
        URL.revokeObjectURL(videoUrl);
      };
      recorder.onerror = () => {
        reject(new Error('Video recording failed to start'));
      };
      recorder.onstart = () => {
        resolve();
      };
      try {
        recorder.start();
      } catch (e) {
        reject(e);
      }
    });
  }

  public stop() {
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.stop();
    }
  }
}
