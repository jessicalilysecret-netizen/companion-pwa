/* sensors.js — 体感事件:吹气 / 摇晃 / 旋转
 * 全部本地分析。只输出离散事件 {event, strength|direction},由 app.js 决定是否进入对话。
 *
 * 吹气:Web Audio 时域 RMS + 频谱平坦度(风噪平坦度远高于语音)+ 低频占比,
 *       三者同时满足才算吹气,轻声说话不误触。1 秒内连续吹气合并为一个事件。
 * 摇晃:devicemotion 线性加速度模长过阈值,600ms 冷却。
 * 旋转:deviceorientation 的 alpha(罗盘向)按屏幕方向换算后累计角度,
 *       同方向累计 >60° 且期间设备基本静止(排除走路/坐车)→ 左转/右转;
 *       beta/gamma 翻越 ±150° → 翻转。
 */
"use strict";

const Sensors = (() => {
  let emit = () => {};        // app.js 注入的回调
  let liveHint = () => {};    // 面板上的实时小字

  // ---------- 吹气 ----------
  let audioCtx = null, analyser = null, micStream = null, blowTimer = null;
  let blowActive = false, blowPeak = 0, blowLastEnd = 0, blowStartT = 0;
  let sensitivity = 5; // 1~10,数字越大越灵敏

  async function startBlow() {
    if (audioCtx) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      liveHint("麦克风授权失败:" + e.message);
      return false;
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    loopBlow();
    return true;
  }

  function stopBlow() {
    if (blowTimer) cancelAnimationFrame(blowTimer);
    blowTimer = null;
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    audioCtx = analyser = micStream = null;
    blowActive = false;
  }

  function loopBlow() {
    const timeBuf = new Float32Array(analyser.fftSize);
    const freqBuf = new Float32Array(analyser.frequencyBinCount);

    function frame() {
      blowTimer = requestAnimationFrame(frame);
      analyser.getFloatTimeDomainData(timeBuf);
      analyser.getFloatFrequencyData(freqBuf);

      // 1) 时域 RMS(音量)
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
      const rms = Math.sqrt(sum / timeBuf.length);

      // 2) 频谱平坦度(几何均值/算术均值,dB 转线性)。风噪≈宽带白噪,平坦度高;语音有共振峰,平坦度低
      // 3) 低频占比:吹气能量集中在 <500Hz
      const nyquist = audioCtx.sampleRate / 2;
      const lowEnd = Math.floor(freqBuf.length * 500 / nyquist);
      let logSum = 0, linSum = 0, lowSum = 0, n = 0;
      for (let i = 1; i < freqBuf.length; i++) {
        const lin = Math.pow(10, freqBuf[i] / 20);
        logSum += Math.log(lin + 1e-12);
        linSum += lin;
        if (i <= lowEnd) lowSum += lin;
        n++;
      }
      const flatness = Math.exp(logSum / n) / (linSum / n + 1e-12);
      const lowRatio = lowSum / (linSum + 1e-12);

      // 阈值:灵敏度滑杆只调 RMS 门限;平坦度/低频是"像不像风"的判据,固定
      const rmsGate = 0.035 * (11 - sensitivity) / 5;   // sens=5 → 0.042
      const isBlow = rms > rmsGate && flatness > 0.12 && lowRatio > 0.55;
      const now = performance.now();

      if (isBlow) {
        if (!blowActive) {
          // 与上一段吹气间隔 <1s → 视为同一次,不重开
          if (now - blowLastEnd > 1000) { blowPeak = 0; blowStartT = now; }
          blowActive = true;
        }
        blowPeak = Math.max(blowPeak, rms);
        blowLastEnd = now;
      } else if (blowActive && now - blowLastEnd > 350) {
        blowActive = false;
        const dur = blowLastEnd - blowStartT;
        if (dur > 120) { // 太短促的(拍麦/爆破音)丢弃
          const strength = Math.min(1, blowPeak / 0.25);
          emit({ event: "user_blowing", strength: +strength.toFixed(2) });
        }
      }
      liveHint(`rms ${rms.toFixed(3)} · 平坦度 ${flatness.toFixed(2)} · 低频 ${lowRatio.toFixed(2)}${blowActive ? " · 🌬️" : ""}`);
    }
    frame();
  }

  // ---------- 摇晃 ----------
  let shakeOn = false, shakeLastT = 0;
  function onMotion(e) {
    if (!shakeOn) return;
    const a = e.acceleration; // 不含重力
    if (!a || a.x === null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    const now = performance.now();
    if (mag > 14 && now - shakeLastT > 600) {
      shakeLastT = now;
      emit({ event: "user_shaking", strength: +Math.min(1, mag / 35).toFixed(2) });
    }
    // 供旋转判定使用:设备是否在大幅移动(走路/坐车会有持续加速度)
    _lastMotionMag = mag;
  }

  // ---------- 旋转 ----------
  let rotateOn = false;
  let lastAlpha = null, accum = 0, lastFlip = 0, rotLastEmit = 0;
  let _lastMotionMag = 0;

  function screenAngle() {
    // 屏幕方向换算:竖屏 0,横屏 ±90 —— alpha 语义随之偏移
    return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  }

  function onOrient(e) {
    if (!rotateOn || e.alpha === null) return;
    const now = performance.now();

    // 翻转:beta 越过 ±150(手机面朝下)
    if (Math.abs(e.beta) > 150 && now - lastFlip > 2000) {
      lastFlip = now;
      emit({ event: "user_flipping" });
      accum = 0; lastAlpha = null;
      return;
    }

    // 左右旋转:alpha 是绕垂直轴的角度(0~360,逆时针增)。换算屏幕方向后取增量。
    const alpha = (e.alpha + screenAngle() + 360) % 360;
    if (lastAlpha !== null) {
      let d = alpha - lastAlpha;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      // 走动/移动时(持续加速度大)不累计——区分"转手机"和"人在动"
      if (_lastMotionMag < 3) accum += d; else accum *= 0.8;
    }
    lastAlpha = alpha;

    if (Math.abs(accum) > 60 && now - rotLastEmit > 1500) {
      rotLastEmit = now;
      // alpha 增 = 设备逆时针 = 用户左转
      emit({ event: accum > 0 ? "user_rotating_left" : "user_rotating_right" });
      accum = 0;
    }
  }

  // ---------- iOS 权限 ----------
  function needsIOSPermission() {
    return typeof DeviceMotionEvent !== "undefined" &&
           typeof DeviceMotionEvent.requestPermission === "function";
  }
  async function requestIOSPermission() {
    try {
      const r1 = await DeviceMotionEvent.requestPermission();
      let r2 = "granted";
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        r2 = await DeviceOrientationEvent.requestPermission();
      }
      return r1 === "granted" && r2 === "granted";
    } catch (_) { return false; }
  }

  window.addEventListener("devicemotion", onMotion);
  window.addEventListener("deviceorientation", onOrient);

  return {
    onEvent(fn) { emit = fn; },
    onLive(fn) { liveHint = fn; },
    setSensitivity(v) { sensitivity = +v; },
    startBlow, stopBlow,
    setShake(on) { shakeOn = on; },
    setRotate(on) { rotateOn = on; lastAlpha = null; accum = 0; },
    needsIOSPermission, requestIOSPermission,
  };
})();
