"use strict";

const PROTOCOL = {
  magic: [0x45, 0x4d, 0x4d, 0x31], // EMM1
  modeRgb: 1,
  preambleA: 1200,
  preambleB: 1900,
  preambleSymbols: 24,
  startFreq: 2300,
  startSymbols: 4,
  nibbleBase: 1400,
  nibbleStep: 50
};

const SYMBOL_MS = 3.2;
const CALIBRATION_SECONDS = 2;
const LOCK_FALLBACK_SECONDS = 6;
const MAX_INVALID_BEFORE_HEADER = 260;
const MAX_INVALID_AFTER_HEADER = 280;
const HEADER_SEARCH_MAX_BYTES = 120;
const MAX_SYMBOLS_PER_PROCESS = 96;
const MAX_PAYLOAD_EMIT_PER_CALL = 220;
const MAX_SAMPLE_BUFFER_SECONDS = 14;
const TRIM_SAMPLE_BUFFER_SECONDS = 8;
const UI_PROGRESS_INTERVAL_MS = 80;

const PRESETS = {
  fast: { width: 24, height: 18 },
  normal: { width: 32, height: 24 },
  slow: { width: 40, height: 30 }
};

const TRACKED_FREQS = (() => {
  const freqs = [PROTOCOL.preambleA, PROTOCOL.preambleB, PROTOCOL.startFreq];
  for (let n = 0; n < 16; n += 1) {
    freqs.push(nibbleToFreq(n));
  }
  return freqs;
})();

const imageInput = document.getElementById("imageInput");
const qualitySelect = document.getElementById("qualitySelect");
const emitVolume = document.getElementById("emitVolume");
const emitVolumeLabel = document.getElementById("emitVolumeLabel");
const emitBtn = document.getElementById("emitBtn");
const emitStatus = document.getElementById("emitStatus");
const emitProgress = document.getElementById("emitProgress");
const emitStageChip = document.getElementById("emitStageChip");
const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
const emitLiveCanvas = document.getElementById("emitLiveCanvas");
const emitLiveCtx = emitLiveCanvas.getContext("2d");

const listenBtn = document.getElementById("listenBtn");
const stopBtn = document.getElementById("stopBtn");
const receiveStatus = document.getElementById("receiveStatus");
const receiveProgress = document.getElementById("receiveProgress");
const receiveMeta = document.getElementById("receiveMeta");
const recvStageChip = document.getElementById("recvStageChip");
const liveCanvas = document.getElementById("liveCanvas");
const liveCtx = liveCanvas.getContext("2d");
const decodeLine = document.getElementById("decodeLine");
const decodeWrap = liveCanvas.parentElement;
const audioScope = document.getElementById("audioScope");
const audioScopeCtx = audioScope.getContext("2d");
const audioLevel = document.getElementById("audioLevel");

const showEmitterBtn = document.getElementById("showEmitter");
const showReceiverBtn = document.getElementById("showReceiver");
const emitterPanel = document.getElementById("emitterPanel");
const receiverPanel = document.getElementById("receiverPanel");

let selectedImage = null;
let selectedImageUrl = null;
let isEmitting = false;

let micStream = null;
let rxAudioCtx = null;
let micSourceNode = null;
let processorNode = null;
let sinkGainNode = null;
let decoder = null;
let calibrationSamples = null;
let calibrationTargetSamples = 0;
let calibrationCollected = 0;
let calibrationComplete = false;
let noLockSeconds = 0;
let fallbackNoiseDisabled = false;

let liveFrameWidth = 0;
let liveFrameHeight = 0;
let liveImageData = null;
let emitLiveImageData = null;
let emitAnimationState = null;
let emitAnimationRaf = 0;
let audioLevelSmooth = 0;
let agcGain = 1;
let currentMicLevelPct = 0;
let weakSignalWarned = false;
let liveRenderScheduled = false;
let lastProgressUiAt = 0;
let scopeDrawToggle = 0;
let currentDecodeRow = 0;

function setStatus(element, text, isError) {
  element.textContent = text;
  element.classList.toggle("error", Boolean(isError));
}

function setStageChip(chip, text, state) {
  chip.textContent = text;
  chip.dataset.state = state || "idle";
}

function drawPlaceholder(canvasCtx, message) {
  const { canvas } = canvasCtx;
  canvasCtx.fillStyle = "#101010";
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  canvasCtx.fillStyle = "#d7d7d7";
  canvasCtx.font = "20px sans-serif";
  canvasCtx.textAlign = "center";
  canvasCtx.textBaseline = "middle";
  canvasCtx.fillText(message, canvas.width / 2, canvas.height / 2);
}

function resetEmitLiveFrame(message) {
  emitLiveCanvas.width = 320;
  emitLiveCanvas.height = 240;
  emitLiveCtx.imageSmoothingEnabled = false;
  emitLiveImageData = null;
  drawPlaceholder(emitLiveCtx, message || "Pret a emettre");
  emitProgress.textContent = "Emission: 0% | Image: 0%";
}

function stopEmitAnimation(finalizePayload) {
  if (emitAnimationRaf) {
    cancelAnimationFrame(emitAnimationRaf);
    emitAnimationRaf = 0;
  }
  if (!emitAnimationState) {
    return;
  }

  if (finalizePayload && emitLiveImageData) {
    const payload = emitAnimationState.payload;
    for (let i = emitAnimationState.emittedPayloadBytes; i < payload.length; i += 1) {
      const pixel = Math.floor(i / 3);
      const channel = i % 3;
      emitLiveImageData.data[pixel * 4 + channel] = payload[i];
    }
    emitLiveCtx.putImageData(emitLiveImageData, 0, 0);
    emitProgress.textContent = "Emission: 100% | Image: 100%";
  }

  emitAnimationState = null;
}

function startEmitAnimation(payload, width, height, packetLength, tonesLength, symbolMs) {
  stopEmitAnimation(false);

  emitLiveCanvas.width = width;
  emitLiveCanvas.height = height;
  emitLiveCtx.imageSmoothingEnabled = false;
  emitLiveImageData = emitLiveCtx.createImageData(width, height);
  for (let i = 3; i < emitLiveImageData.data.length; i += 4) {
    emitLiveImageData.data[i] = 255;
  }
  emitLiveCtx.putImageData(emitLiveImageData, 0, 0);

  emitAnimationState = {
    payload,
    width,
    height,
    packetLength,
    totalDataSymbols: packetLength * 2,
    preambleSymbols: PROTOCOL.preambleSymbols + PROTOCOL.startSymbols,
    symbolMs,
    startAtMs: performance.now() + 85,
    totalMs: tonesLength * symbolMs,
    emittedPayloadBytes: 0
  };

  const tick = () => {
    if (!emitAnimationState || !isEmitting) {
      return;
    }

    const state = emitAnimationState;
    const elapsedMs = Math.max(0, performance.now() - state.startAtMs);
    const symbolPos = Math.floor(elapsedMs / state.symbolMs);
    const dataSymbols = Math.max(0, Math.min(state.totalDataSymbols, symbolPos - state.preambleSymbols));
    const dataBytes = Math.floor(dataSymbols / 2);
    const payloadTarget = Math.min(state.payload.length, Math.max(0, dataBytes - 7));

    let changed = false;
    let updates = 0;
    while (state.emittedPayloadBytes < payloadTarget && updates < 420) {
      const payloadIndex = state.emittedPayloadBytes;
      const pixel = Math.floor(payloadIndex / 3);
      const channel = payloadIndex % 3;
      emitLiveImageData.data[pixel * 4 + channel] = state.payload[payloadIndex];
      state.emittedPayloadBytes += 1;
      updates += 1;
      changed = true;
    }

    if (changed) {
      emitLiveCtx.putImageData(emitLiveImageData, 0, 0);
    }

    const imagePct = Math.min(100, Math.round((state.emittedPayloadBytes / state.payload.length) * 100));
    const emissionPct = Math.min(100, Math.round((elapsedMs / state.totalMs) * 100));
    emitProgress.textContent = `Emission: ${emissionPct}% | Image: ${imagePct}%`;

    if (state.emittedPayloadBytes >= state.payload.length && elapsedMs > state.totalMs + 120) {
      return;
    }

    emitAnimationRaf = requestAnimationFrame(tick);
  };

  emitAnimationRaf = requestAnimationFrame(tick);
}

function drawAudioScope(samples) {
  const w = audioScope.width;
  const h = audioScope.height;
  audioScopeCtx.fillStyle = "#04130f";
  audioScopeCtx.fillRect(0, 0, w, h);

  audioScopeCtx.strokeStyle = "#1e6a5a";
  audioScopeCtx.lineWidth = 1;
  audioScopeCtx.beginPath();
  audioScopeCtx.moveTo(0, h / 2);
  audioScopeCtx.lineTo(w, h / 2);
  audioScopeCtx.stroke();

  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    energy += samples[i] * samples[i];
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  audioLevelSmooth = audioLevelSmooth * 0.88 + rms * 0.12;
  const levelPct = Math.min(100, Math.round(audioLevelSmooth * 700));
  currentMicLevelPct = levelPct;
  audioLevel.textContent = `Niveau micro: ${levelPct}%`;

  audioScopeCtx.strokeStyle = "#3fe0c0";
  audioScopeCtx.lineWidth = 2;
  audioScopeCtx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / w));
  let x = 0;
  for (let i = 0; i < samples.length && x < w; i += step) {
    const y = h / 2 + samples[i] * (h * 0.44);
    if (x === 0) {
      audioScopeCtx.moveTo(x, y);
    } else {
      audioScopeCtx.lineTo(x, y);
    }
    x += 1;
  }
  audioScopeCtx.stroke();
}

function scheduleLiveRender() {
  if (liveRenderScheduled) {
    return;
  }
  liveRenderScheduled = true;
  requestAnimationFrame(() => {
    liveRenderScheduled = false;
    if (liveImageData) {
      liveCtx.putImageData(liveImageData, 0, 0);
    }
  });
}

function setDecodeRow(rowIndex) {
  currentDecodeRow = Math.max(0, Math.min(liveFrameHeight - 1, rowIndex));
  if (liveFrameHeight > 0) {
    receiveMeta.textContent = `Ligne decodee: ${currentDecodeRow + 1}/${liveFrameHeight}`;
    const yPct = (currentDecodeRow / liveFrameHeight) * 100;
    decodeLine.style.transform = `translateY(${yPct}%)`;
  } else {
    receiveMeta.textContent = "Ligne decodee: 0";
    decodeLine.style.transform = "translateY(0%)";
  }
}

function setRole(mode) {
  const emitterMode = mode === "emitter";
  emitterPanel.classList.toggle("hidden", !emitterMode);
  receiverPanel.classList.toggle("hidden", emitterMode);
  showEmitterBtn.classList.toggle("active", emitterMode);
  showReceiverBtn.classList.toggle("active", !emitterMode);
}

function getPreset() {
  return PRESETS[qualitySelect.value] || PRESETS.normal;
}

function nibbleToFreq(nibble) {
  return PROTOCOL.nibbleBase + nibble * PROTOCOL.nibbleStep;
}

function clampByte(v) {
  return Math.max(0, Math.min(255, v | 0));
}

async function loadImageFromFile(file) {
  if (!file) {
    return null;
  }

  if (selectedImageUrl) {
    URL.revokeObjectURL(selectedImageUrl);
    selectedImageUrl = null;
  }

  selectedImageUrl = URL.createObjectURL(file);

  if ("createImageBitmap" in window) {
    return await createImageBitmap(file);
  }

  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image invalide"));
    img.src = selectedImageUrl;
  });
}

function drawPreview(img) {
  previewCtx.fillStyle = "#101010";
  previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  if (!img) {
    drawPlaceholder(previewCtx, "Aucune image");
    return;
  }

  const cw = previewCanvas.width;
  const ch = previewCanvas.height;
  const ratio = Math.min(cw / img.width, ch / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  const x = (cw - w) / 2;
  const y = (ch - h) / 2;
  previewCtx.drawImage(img, x, y, w, h);
}

function imageToRgbPayload(img, width, height) {
  const temp = document.createElement("canvas");
  temp.width = width;
  temp.height = height;
  const ctx = temp.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const payload = new Uint8Array(width * height * 3);
  let write = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    payload[write++] = clampByte(rgba[i]);
    payload[write++] = clampByte(rgba[i + 1]);
    payload[write++] = clampByte(rgba[i + 2]);
  }
  return payload;
}

function buildPacket(payload, width, height) {
  const header = new Uint8Array([
    ...PROTOCOL.magic,
    clampByte(width),
    clampByte(height),
    PROTOCOL.modeRgb
  ]);

  const packetWithoutChecksum = new Uint8Array(header.length + payload.length);
  packetWithoutChecksum.set(header, 0);
  packetWithoutChecksum.set(payload, header.length);

  let checksum = 0;
  for (let i = 0; i < packetWithoutChecksum.length; i += 1) {
    checksum = (checksum + packetWithoutChecksum[i]) & 0xffff;
  }

  const packet = new Uint8Array(packetWithoutChecksum.length + 2);
  packet.set(packetWithoutChecksum, 0);
  packet[packetWithoutChecksum.length] = (checksum >> 8) & 0xff;
  packet[packetWithoutChecksum.length + 1] = checksum & 0xff;
  return packet;
}

function packetToTones(packet) {
  const tones = [];

  for (let i = 0; i < PROTOCOL.preambleSymbols; i += 1) {
    tones.push(i % 2 === 0 ? PROTOCOL.preambleA : PROTOCOL.preambleB);
  }
  for (let i = 0; i < PROTOCOL.startSymbols; i += 1) {
    tones.push(PROTOCOL.startFreq);
  }

  for (let i = 0; i < packet.length; i += 1) {
    const byte = packet[i];
    tones.push(nibbleToFreq((byte >> 4) & 0x0f));
    tones.push(nibbleToFreq(byte & 0x0f));
  }

  return tones;
}

async function playToneSequence(tones, symbolMs, outputGain) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  await audioCtx.resume();

  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = "sine";
  oscillator.connect(gain);
  gain.connect(audioCtx.destination);

  const symbolDuration = symbolMs / 1000;
  const startTime = audioCtx.currentTime + 0.08;
  const endTime = startTime + tones.length * symbolDuration;

  for (let i = 0; i < tones.length; i += 1) {
    oscillator.frequency.setValueAtTime(tones[i], startTime + i * symbolDuration);
  }

  const amp = Math.max(0.05, Math.min(0.85, outputGain));
  gain.gain.setValueAtTime(0, startTime - 0.02);
  gain.gain.linearRampToValueAtTime(amp, startTime);
  gain.gain.setValueAtTime(amp, endTime - 0.01);
  gain.gain.linearRampToValueAtTime(0, endTime);

  return await new Promise((resolve) => {
    oscillator.onended = async () => {
      try {
        await audioCtx.close();
      } catch (_) {
      }
      resolve();
    };

    oscillator.start(startTime - 0.02);
    oscillator.stop(endTime + 0.02);
  });
}

function goertzelPower(samples, start, size, freq, sampleRate) {
  const omega = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;

  const end = Math.min(samples.length, start + size);
  for (let i = start; i < end; i += 1) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }

  return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}

function normalizeInputChunk(input) {
  let energy = 0;
  for (let i = 0; i < input.length; i += 1) {
    energy += input[i] * input[i];
  }
  const rms = Math.sqrt(energy / Math.max(1, input.length));
  if (rms <= 0) {
    return input;
  }

  const targetRms = 0.085;
  const desiredGain = Math.min(28, Math.max(1, targetRms / (rms + 1e-9)));
  agcGain = agcGain * 0.84 + desiredGain * 0.16;

  if (agcGain <= 1.05) {
    return input;
  }

  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] * agcGain * 1.6;
    out[i] = Math.tanh(sample);
  }
  return out;
}

class AcousticSstvDecoder {
  constructor(sampleRate, symbolMs, callbacks) {
    this.sampleRate = sampleRate;
    this.symbolSamples = Math.max(64, Math.round((sampleRate * symbolMs) / 1000));
    this.callbacks = callbacks;

    this.samples = [];
    this.scanStart = 0;
    this.locked = false;
    this.decodeCursor = 0;
    this.pendingNibble = null;
    this.bytes = [];
    this.expectedTotal = null;
    this.payloadLength = null;
    this.emittedPayloadBytes = 0;
    this.invalidSymbols = 0;
    this.noiseFloorByFreq = Object.create(null);
    this.noiseReady = false;
    this.lockDataStartCursor = 0;
    this.phaseShiftTried = false;
  }

  setNoiseProfileFromSamples(samples) {
    const windowCount = Math.floor(samples.length / this.symbolSamples);
    if (windowCount < 4) {
      return false;
    }

    for (const freq of TRACKED_FREQS) {
      this.noiseFloorByFreq[freq] = 0;
    }

    for (let window = 0; window < windowCount; window += 1) {
      const start = window * this.symbolSamples;
      for (const freq of TRACKED_FREQS) {
        this.noiseFloorByFreq[freq] += goertzelPower(
          samples,
          start,
          this.symbolSamples,
          freq,
          this.sampleRate
        );
      }
    }

    for (const freq of TRACKED_FREQS) {
      this.noiseFloorByFreq[freq] /= windowCount;
    }

    this.noiseReady = true;
    return true;
  }

  disableNoiseProfile() {
    this.noiseReady = false;
  }

  adjustedPower(start, freq) {
    const rawPower = goertzelPower(
      this.samples,
      start,
      this.symbolSamples,
      freq,
      this.sampleRate
    );
    if (!this.noiseReady) {
      return rawPower;
    }
    const floor = Math.max(1e-12, this.noiseFloorByFreq[freq] || 0);
    return rawPower / (floor * 0.85 + 1e-12);
  }

  resetToSearch(statusText, isError) {
    this.locked = false;
    this.decodeCursor = 0;
    this.pendingNibble = null;
    this.bytes = [];
    this.expectedTotal = null;
    this.payloadLength = null;
    this.emittedPayloadBytes = 0;
    this.invalidSymbols = 0;
    this.lockDataStartCursor = 0;
    this.phaseShiftTried = false;
    this.scanStart = Math.max(0, this.samples.length - this.symbolSamples * 6);
    if (statusText) {
      this.callbacks.onStatus(statusText, Boolean(isError));
    }
    if (this.callbacks.onSync) {
      this.callbacks.onSync(0);
    }
    this.callbacks.onProgress(0);
  }

  tryPhaseShift() {
    if (this.phaseShiftTried) {
      return false;
    }
    this.phaseShiftTried = true;
    this.decodeCursor = this.lockDataStartCursor + this.symbolSamples;
    this.pendingNibble = null;
    this.bytes = [];
    this.expectedTotal = null;
    this.payloadLength = null;
    this.emittedPayloadBytes = 0;
    this.invalidSymbols = 0;
    this.callbacks.onStatus("Recalage du signal...", false);
    if (this.callbacks.onSync) {
      this.callbacks.onSync(0);
    }
    return true;
  }

  append(input) {
    for (let i = 0; i < input.length; i += 1) {
      this.samples.push(input[i]);
    }

    const maxSamples = Math.round(this.sampleRate * MAX_SAMPLE_BUFFER_SECONDS);
    if (this.samples.length > maxSamples) {
      const trimTo = Math.round(this.sampleRate * TRIM_SAMPLE_BUFFER_SECONDS);
      const cut = this.samples.length - trimTo;
      this.samples.splice(0, cut);
      this.scanStart = Math.max(0, this.scanStart - cut);
      if (this.locked) {
        this.decodeCursor = Math.max(0, this.decodeCursor - cut);
        this.lockDataStartCursor = Math.max(0, this.lockDataStartCursor - cut);
      }
    }
  }

  process() {
    if (!this.locked) {
      this.tryLock();
    }
    if (this.locked) {
      this.decodeSymbols(MAX_SYMBOLS_PER_PROCESS);
      this.flushBufferedPayload(MAX_PAYLOAD_EMIT_PER_CALL);
    }
  }

  tryLock() {
    const needSymbols = PROTOCOL.preambleSymbols + PROTOCOL.startSymbols + 4;
    const needSamples = needSymbols * this.symbolSamples;
    if (this.samples.length < needSamples) {
      return;
    }

    const step = Math.max(4, Math.floor(this.symbolSamples / 4));
    const maxOffset = this.samples.length - needSamples;
    const minScore = Math.floor(PROTOCOL.preambleSymbols * 0.62);
    let best = null;

    for (let offset = this.scanStart; offset <= maxOffset; offset += step) {
      let preambleScore = 0;
      for (let i = 0; i < PROTOCOL.preambleSymbols; i += 1) {
        const start = offset + i * this.symbolSamples;
        const pA = this.adjustedPower(start, PROTOCOL.preambleA);
        const pB = this.adjustedPower(start, PROTOCOL.preambleB);
        const expectA = i % 2 === 0;
        if ((expectA && pA > pB * 1.1) || (!expectA && pB > pA * 1.1)) {
          preambleScore += 1;
        }
      }

      if (preambleScore < minScore) {
        continue;
      }

      let startScore = 0;
      for (let j = 0; j < PROTOCOL.startSymbols; j += 1) {
        const start = offset + (PROTOCOL.preambleSymbols + j) * this.symbolSamples;
        const pS = this.adjustedPower(start, PROTOCOL.startFreq);
        const pA = this.adjustedPower(start, PROTOCOL.preambleA);
        const pB = this.adjustedPower(start, PROTOCOL.preambleB);
        if (pS > Math.max(pA, pB) * 1.1) {
          startScore += 1;
        }
      }

      if (startScore < 2) {
        continue;
      }

      const score = preambleScore + startScore;
      if (!best || score > best.score) {
        best = { score, offset };
      }
    }

    this.scanStart = Math.max(0, maxOffset - this.symbolSamples);

    if (!best) {
      return;
    }

    this.locked = true;
    this.decodeCursor = best.offset + (PROTOCOL.preambleSymbols + PROTOCOL.startSymbols) * this.symbolSamples;
    this.lockDataStartCursor = this.decodeCursor;
    this.phaseShiftTried = false;
    this.pendingNibble = null;
    this.bytes = [];
    this.expectedTotal = null;
    this.payloadLength = null;
    this.emittedPayloadBytes = 0;
    this.invalidSymbols = 0;
    this.callbacks.onStatus("Signal detecte. Decodage en cours...", false);
    if (this.callbacks.onSync) {
      this.callbacks.onSync(0);
    }
  }

  classifyNibble(start) {
    let bestNibble = 0;
    let bestPower = -Infinity;
    let secondPower = -Infinity;

    for (let n = 0; n < 16; n += 1) {
      const p = this.adjustedPower(start, nibbleToFreq(n));

      if (p > bestPower) {
        secondPower = bestPower;
        bestPower = p;
        bestNibble = n;
      } else if (p > secondPower) {
        secondPower = p;
      }
    }

    const confidence = bestPower / (secondPower + 1e-9);
    if (confidence < 1.008) {
      return null;
    }
    return bestNibble;
  }

  flushBufferedPayload(maxToEmit) {
    if (!this.expectedTotal) {
      return;
    }

    const payloadStart = 7;
    const availablePayloadBytes = Math.max(
      0,
      Math.min(this.payloadLength, this.bytes.length - payloadStart)
    );

    let emitted = 0;
    while (this.emittedPayloadBytes < availablePayloadBytes && emitted < maxToEmit) {
      const payloadIndex = this.emittedPayloadBytes;
      const payloadByte = this.bytes[payloadStart + payloadIndex];
      this.callbacks.onPayloadByte(payloadIndex, payloadByte, this.payloadLength);
      this.emittedPayloadBytes += 1;
      emitted += 1;
    }
  }

  handleByte(byte) {
    this.bytes.push(byte);

    if (!this.expectedTotal) {
      if (this.callbacks.onSync) {
        this.callbacks.onSync(Math.min(7, this.bytes.length));
      }

      if (this.bytes.length >= 7) {
        const scanStart = Math.max(0, this.bytes.length - 32);
        let headerPos = -1;
        for (let p = scanStart; p <= this.bytes.length - 7; p += 1) {
          if (
            this.bytes[p] === PROTOCOL.magic[0] &&
            this.bytes[p + 1] === PROTOCOL.magic[1] &&
            this.bytes[p + 2] === PROTOCOL.magic[2] &&
            this.bytes[p + 3] === PROTOCOL.magic[3]
          ) {
            const width = this.bytes[p + 4];
            const height = this.bytes[p + 5];
            const mode = this.bytes[p + 6];
            if (mode === PROTOCOL.modeRgb && width >= 8 && height >= 8 && width <= 64 && height <= 64) {
              headerPos = p;
              break;
            }
          }
        }

        if (headerPos >= 0) {
          if (headerPos > 0) {
            this.bytes = this.bytes.slice(headerPos);
          }
          const width = this.bytes[4];
          const height = this.bytes[5];
          this.payloadLength = width * height * 3;
          this.expectedTotal = 7 + this.payloadLength + 2;
          this.emittedPayloadBytes = 0;
          this.callbacks.onFrameStart(width, height);
        }
      }

      if (!this.expectedTotal && this.bytes.length >= HEADER_SEARCH_MAX_BYTES) {
        if (!this.tryPhaseShift()) {
          this.resetToSearch("Entete non detectee. Nouvelle ecoute...", true);
        }
      }
    }

    if (!this.expectedTotal) {
      return;
    }

    this.flushBufferedPayload(MAX_PAYLOAD_EMIT_PER_CALL);

    if (this.bytes.length >= this.expectedTotal) {
      let checksum = 0;
      for (let i = 0; i < this.expectedTotal - 2; i += 1) {
        checksum = (checksum + this.bytes[i]) & 0xffff;
      }
      const expected = ((this.bytes[this.expectedTotal - 2] << 8) | this.bytes[this.expectedTotal - 1]) & 0xffff;
      if (checksum === expected) {
        this.callbacks.onProgress(100);
        this.callbacks.onStatus("Image recue avec succes.", false);
        this.resetToSearch("En ecoute d'un nouveau signal...", false);
      } else {
        this.callbacks.onStatus("Checksum invalide. Recommence l'emission.", true);
        this.resetToSearch("En ecoute d'un nouveau signal...", true);
      }
    } else {
      const pct = Math.min(
        100,
        Math.round((this.emittedPayloadBytes / (this.payloadLength || 1)) * 100)
      );
      this.callbacks.onProgress(pct);
    }
  }

  decodeSymbols(maxSymbols) {
    let processed = 0;
    while (this.decodeCursor + this.symbolSamples <= this.samples.length && processed < maxSymbols) {
      const nibble = this.classifyNibble(this.decodeCursor);
      this.decodeCursor += this.symbolSamples;
      processed += 1;

      if (nibble === null) {
        this.invalidSymbols += 1;
        const maxInvalid = this.expectedTotal ? MAX_INVALID_AFTER_HEADER : MAX_INVALID_BEFORE_HEADER;
        if (this.invalidSymbols > maxInvalid) {
          this.resetToSearch("Signal perdu. Nouvelle ecoute...", true);
          break;
        }
        continue;
      }

      this.invalidSymbols = 0;
      if (this.pendingNibble === null) {
        this.pendingNibble = nibble;
      } else {
        const byte = (this.pendingNibble << 4) | nibble;
        this.pendingNibble = null;
        this.handleByte(byte);
      }
    }
  }
}

function onFrameStart(width, height) {
  liveFrameWidth = width;
  liveFrameHeight = height;
  liveCanvas.width = width;
  liveCanvas.height = height;
  liveCtx.imageSmoothingEnabled = false;
  decodeWrap.classList.add("active");

  liveImageData = liveCtx.createImageData(width, height);
  for (let i = 3; i < liveImageData.data.length; i += 4) {
    liveImageData.data[i] = 255;
  }
  lastProgressUiAt = 0;
  liveRenderScheduled = false;
  setDecodeRow(0);
  liveCtx.putImageData(liveImageData, 0, 0);
}

function onPayloadByte(payloadIndex, value, payloadLength) {
  if (!liveImageData) {
    return;
  }
  const pixel = Math.floor(payloadIndex / 3);
  const channel = payloadIndex % 3;
  const offset = pixel * 4 + channel;
  liveImageData.data[offset] = value;

  const shouldDrawRow = channel === 2 && (pixel + 1) % liveFrameWidth === 0;
  const shouldDrawPulse = payloadIndex % 220 === 0;
  if (shouldDrawRow || shouldDrawPulse) {
    scheduleLiveRender();
  }

  if (channel === 2 && liveFrameWidth > 0) {
    const row = Math.floor(pixel / liveFrameWidth);
    if (row !== currentDecodeRow) {
      setDecodeRow(row);
    }
  }

  const pct = Math.min(100, Math.round(((payloadIndex + 1) / payloadLength) * 100));
  const now = performance.now();
  if (pct === 100 || now - lastProgressUiAt >= UI_PROGRESS_INTERVAL_MS) {
    receiveProgress.textContent = `Progression: ${pct}%`;
    lastProgressUiAt = now;
  }
}

async function startReceiver() {
  if (rxAudioCtx) {
    setStatus(receiveStatus, "Le recever est deja actif.", false);
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        latency: 0,
        advanced: [{
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          googEchoCancellation: false,
          googNoiseSuppression: false,
          googAutoGainControl: false,
          googHighpassFilter: false
        }]
      },
      video: false
    });

    const micTrack = micStream.getAudioTracks()[0];
    if (micTrack && micTrack.applyConstraints) {
      try {
        await micTrack.applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          latency: 0
        });
      } catch (_) {
      }
    }

    rxAudioCtx = new AudioCtx();
    await rxAudioCtx.resume();

    micSourceNode = rxAudioCtx.createMediaStreamSource(micStream);
    processorNode = rxAudioCtx.createScriptProcessor(2048, 1, 1);
    sinkGainNode = rxAudioCtx.createGain();
    sinkGainNode.gain.value = 0;

    decoder = new AcousticSstvDecoder(rxAudioCtx.sampleRate, SYMBOL_MS, {
      onStatus: (text, isError) => {
        setStatus(receiveStatus, text, isError);
        const lower = String(text).toLowerCase();
        if (lower.includes("signal detecte") || lower.includes("decodage")) {
          setStageChip(recvStageChip, "Recever: decodage", "active");
        } else if (lower.includes("image recue")) {
          setStageChip(recvStageChip, "Recever: image recue", "active");
        } else if (lower.includes("signal perdu") || lower.includes("invalide")) {
          setStageChip(recvStageChip, "Recever: recherche", "warn");
        }
      },
      onSync: (count) => {
        if (decoder && !decoder.expectedTotal) {
          receiveProgress.textContent = `Sync entete: ${Math.max(0, Math.min(7, count))}/7`;
        }
      },
      onProgress: (pct) => {
        receiveProgress.textContent = `Progression: ${Math.max(0, Math.min(100, pct))}%`;
        if (pct >= 100) {
          scheduleLiveRender();
        }
      },
      onFrameStart,
      onPayloadByte
    });

    calibrationTargetSamples = Math.max(
      1,
      Math.round(rxAudioCtx.sampleRate * CALIBRATION_SECONDS)
    );
    calibrationSamples = new Float32Array(calibrationTargetSamples);
    calibrationCollected = 0;
    calibrationComplete = false;
    noLockSeconds = 0;
    fallbackNoiseDisabled = false;
    audioLevelSmooth = 0;
    agcGain = 1;
    currentMicLevelPct = 0;
    weakSignalWarned = false;

    processorNode.onaudioprocess = (event) => {
      if (!decoder) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      scopeDrawToggle = (scopeDrawToggle + 1) % 2;
      if (scopeDrawToggle === 0) {
        drawAudioScope(input);
      }

      if (!calibrationComplete) {
        const remaining = calibrationTargetSamples - calibrationCollected;
        const take = Math.min(remaining, input.length);
        calibrationSamples.set(input.subarray(0, take), calibrationCollected);
        calibrationCollected += take;

        const calibrationPct = Math.min(
          100,
          Math.round((calibrationCollected / calibrationTargetSamples) * 100)
        );
        receiveProgress.textContent = `Calibration: ${calibrationPct}%`;

        if (calibrationCollected >= calibrationTargetSamples) {
          const calibrated = decoder.setNoiseProfileFromSamples(calibrationSamples);
          calibrationSamples = null;
          calibrationTargetSamples = 0;
          calibrationCollected = 0;
          calibrationComplete = true;
          if (calibrated) {
            setStatus(receiveStatus, "Calibration terminee. En attente du signal SSTV...", false);
          } else {
            setStatus(receiveStatus, "Calibration trop courte. En attente du signal SSTV...", true);
          }
          receiveProgress.textContent = "Progression: 0%";
          drawPlaceholder(liveCtx, "En attente du signal");

          if (take < input.length) {
            const tail = input.subarray(take);
            decoder.append(tail);
            decoder.process();
          }
        }
        return;
      }

      const normalizedInput = normalizeInputChunk(input);
      decoder.append(normalizedInput);
      decoder.process();

      if (!decoder.locked) {
        noLockSeconds += input.length / rxAudioCtx.sampleRate;
        if (!weakSignalWarned && noLockSeconds >= 2.5 && currentMicLevelPct < 3) {
          weakSignalWarned = true;
          setStatus(
            receiveStatus,
            "Signal trop faible. Monte le volume emmeteur et rapproche le micro du haut-parleur.",
            true
          );
        }
        if (!fallbackNoiseDisabled && decoder.noiseReady && noLockSeconds >= LOCK_FALLBACK_SECONDS) {
          decoder.disableNoiseProfile();
          fallbackNoiseDisabled = true;
          setStatus(
            receiveStatus,
            "Mode compatibilite active: calibration bruit desactivee pour mieux detecter le signal.",
            false
          );
          drawPlaceholder(liveCtx, "Mode compatibilite actif");
        }
      } else {
        noLockSeconds = 0;
        weakSignalWarned = false;
      }
    };

    micSourceNode.connect(processorNode);
    processorNode.connect(sinkGainNode);
    sinkGainNode.connect(rxAudioCtx.destination);

    setStatus(receiveStatus, "Micro actif. Calibration bruit ambiant pendant 2 secondes...", false);
    receiveProgress.textContent = "Calibration: 0%";
    receiveMeta.textContent = "Ligne decodee: 0";
    drawPlaceholder(liveCtx, "Calibration 2 secondes");
    drawPlaceholder(audioScopeCtx, "Micro en direct");
    audioLevel.textContent = "Niveau micro: 0%";
    decodeWrap.classList.remove("active");
    decodeLine.style.transform = "translateY(0%)";
    setStageChip(recvStageChip, "Recever: ecoute", "active");
  } catch (error) {
    stopReceiver();
    setStatus(receiveStatus, `Erreur micro: ${error.message}`, true);
    setStageChip(recvStageChip, "Recever: erreur", "warn");
  }
}

function stopReceiver() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (micSourceNode) {
    micSourceNode.disconnect();
    micSourceNode = null;
  }
  if (sinkGainNode) {
    sinkGainNode.disconnect();
    sinkGainNode = null;
  }
  if (micStream) {
    for (const track of micStream.getTracks()) {
      track.stop();
    }
    micStream = null;
  }
  if (rxAudioCtx) {
    rxAudioCtx.close().catch(() => {});
    rxAudioCtx = null;
  }
  calibrationSamples = null;
  calibrationTargetSamples = 0;
  calibrationCollected = 0;
  calibrationComplete = false;
  noLockSeconds = 0;
  fallbackNoiseDisabled = false;
  audioLevelSmooth = 0;
  agcGain = 1;
  currentMicLevelPct = 0;
  weakSignalWarned = false;
  decoder = null;
  liveImageData = null;
  liveRenderScheduled = false;
  scopeDrawToggle = 0;
  currentDecodeRow = 0;
  receiveMeta.textContent = "Ligne decodee: 0";
  decodeWrap.classList.remove("active");
  decodeLine.style.transform = "translateY(0%)";
  setStageChip(recvStageChip, "Recever: idle", "idle");
  drawPlaceholder(audioScopeCtx, "Micro inactif");
  audioLevel.textContent = "Niveau micro: 0%";
}

async function emitImage() {
  if (!selectedImage) {
    setStatus(emitStatus, "Choisis une image avant Emmiter.", true);
    setStageChip(emitStageChip, "Emmiter: image manquante", "warn");
    return;
  }
  if (isEmitting) {
    return;
  }

  const preset = getPreset();
  const payload = imageToRgbPayload(selectedImage, preset.width, preset.height);
  const packet = buildPacket(payload, preset.width, preset.height);
  const tones = packetToTones(packet);
  const etaSec = (tones.length * SYMBOL_MS) / 1000;
  const volumePct = Number(emitVolume.value || 92);
  const outputGain = Math.max(0.08, Math.min(0.85, volumePct / 120));
  let emitFailed = false;

  isEmitting = true;
  emitBtn.disabled = true;
  setStageChip(emitStageChip, "Emmiter: emission", "active");
  startEmitAnimation(payload, preset.width, preset.height, packet.length, tones.length, SYMBOL_MS);
  setStatus(
    emitStatus,
    `Emission en cours (${preset.width}x${preset.height}, ~${etaSec.toFixed(1)}s, volume ${volumePct}%)...`,
    false
  );

  try {
    await playToneSequence(tones, SYMBOL_MS, outputGain);
    stopEmitAnimation(true);
    setStatus(emitStatus, "Emission terminee.", false);
    setStageChip(emitStageChip, "Emmiter: emission terminee", "active");
  } catch (error) {
    emitFailed = true;
    stopEmitAnimation(false);
    setStatus(emitStatus, `Erreur emission: ${error.message}`, true);
    setStageChip(emitStageChip, "Emmiter: erreur", "warn");
  } finally {
    if (!emitFailed && emitAnimationState) {
      stopEmitAnimation(true);
    }
    emitBtn.disabled = false;
    isEmitting = false;
  }
}

showEmitterBtn.addEventListener("click", () => setRole("emitter"));
showReceiverBtn.addEventListener("click", () => setRole("receiver"));

imageInput.addEventListener("change", async () => {
  const file = imageInput.files && imageInput.files[0];
  if (!file) {
    selectedImage = null;
    drawPreview(null);
    resetEmitLiveFrame("Pret a emettre");
    setStageChip(emitStageChip, "Emmiter: idle", "idle");
    setStatus(emitStatus, "Choisis une image puis clique sur Emmiter.", false);
    return;
  }

  try {
    selectedImage = await loadImageFromFile(file);
    drawPreview(selectedImage);
    resetEmitLiveFrame("Attente emission");
    setStageChip(emitStageChip, "Emmiter: image chargee", "active");
    setStatus(emitStatus, "Image chargee. Tu peux cliquer sur Emmiter.", false);
  } catch (error) {
    selectedImage = null;
    drawPreview(null);
    resetEmitLiveFrame("Image invalide");
    setStageChip(emitStageChip, "Emmiter: erreur image", "warn");
    setStatus(emitStatus, `Image invalide: ${error.message}`, true);
  }
});

emitVolume.addEventListener("input", () => {
  emitVolumeLabel.textContent = `${emitVolume.value}%`;
});

emitBtn.addEventListener("click", emitImage);
listenBtn.addEventListener("click", startReceiver);
stopBtn.addEventListener("click", () => {
  stopReceiver();
  setStatus(receiveStatus, "Recever arrete.", false);
  drawPlaceholder(liveCtx, "Signal en attente");
  drawPlaceholder(audioScopeCtx, "Micro inactif");
  audioLevel.textContent = "Niveau micro: 0%";
  receiveProgress.textContent = "Progression: 0%";
  receiveMeta.textContent = "Ligne decodee: 0";
});

window.addEventListener("beforeunload", () => {
  stopEmitAnimation(false);
  stopReceiver();
  if (selectedImageUrl) {
    URL.revokeObjectURL(selectedImageUrl);
  }
});

drawPlaceholder(previewCtx, "Aucune image");
drawPlaceholder(liveCtx, "Signal en attente");
drawPlaceholder(audioScopeCtx, "Micro inactif");
resetEmitLiveFrame("Pret a emettre");
setStageChip(emitStageChip, "Emmiter: idle", "idle");
setStageChip(recvStageChip, "Recever: idle", "idle");
