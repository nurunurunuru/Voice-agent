/**
 * widget.js — Embeddable Realtime Voice Agent Widget
 *
 * ব্যবহার:
 * <script src="https://YOUR_SERVER/widget.js" data-agent-id="AGENT_ID" data-server="https://YOUR_SERVER" async></script>
 * এটা টার্গেট ওয়েবসাইটের <body> এর মধ্যে যেকোনো জায়গায় বসালেই চলবে।
 */
(function () {
  "use strict";

  var scriptTag = document.currentScript;
  var AGENT_ID = scriptTag.getAttribute("data-agent-id");
  var SERVER = (scriptTag.getAttribute("data-server") || "").replace(/\/$/, "");
  var PRIMARY_COLOR = scriptTag.getAttribute("data-color") || "#6d28d9";
  var AGENT_NAME = scriptTag.getAttribute("data-name") || "AI সহায়ক";

  if (!AGENT_ID || !SERVER) {
    console.error("[voice-agent] data-agent-id বা data-server missing");
    return;
  }

  var WS_URL = SERVER.replace(/^http/, "ws") + "/ws/voice?agentId=" + encodeURIComponent(AGENT_ID);

  // ---------- UI তৈরি ----------
  var style = document.createElement("style");
  style.textContent =
    "#va-bubble{position:fixed;bottom:24px;right:24px;width:64px;height:64px;border-radius:50%;" +
    "background:" + PRIMARY_COLOR + ";box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;z-index:999999;" +
    "display:flex;align-items:center;justify-content:center;transition:transform .2s ease;border:none;}" +
    "#va-bubble:hover{transform:scale(1.06);}" +
    "#va-bubble svg{width:28px;height:28px;fill:#fff;}" +
    "#va-panel{position:fixed;bottom:100px;right:24px;width:320px;max-width:90vw;height:440px;" +
    "background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.25);z-index:999999;" +
    "display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}" +
    "#va-panel.open{display:flex;}" +
    "#va-header{background:" + PRIMARY_COLOR + ";color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;}" +
    "#va-header .va-title{font-weight:600;font-size:15px;}" +
    "#va-header .va-sub{font-size:12px;opacity:.85;}" +
    "#va-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:4px;}" +
    "#va-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;background:#faf9fc;}" +
    "#va-orb{width:96px;height:96px;border-radius:50%;background:radial-gradient(circle at 30% 30%," + PRIMARY_COLOR + ",#2e1065);" +
    "display:flex;align-items:center;justify-content:center;transition:box-shadow .15s ease;}" +
    "#va-orb.listening{box-shadow:0 0 0 8px rgba(109,40,217,.15);}" +
    "#va-orb.speaking{box-shadow:0 0 0 8px rgba(109,40,217,.3);animation:va-pulse 1s infinite;}" +
    "@keyframes va-pulse{0%{box-shadow:0 0 0 4px rgba(109,40,217,.25);}50%{box-shadow:0 0 0 14px rgba(109,40,217,.05);}100%{box-shadow:0 0 0 4px rgba(109,40,217,.25);}}" +
    "#va-orb svg{width:36px;height:36px;fill:#fff;}" +
    "#va-status{font-size:13px;color:#555;text-align:center;min-height:18px;}" +
    "#va-mic-btn{border:none;background:" + PRIMARY_COLOR + ";color:#fff;padding:10px 20px;border-radius:999px;" +
    "font-size:14px;cursor:pointer;font-weight:600;}" +
    "#va-mic-btn:disabled{opacity:.5;cursor:not-allowed;}" +
    "#va-footer{font-size:10px;color:#999;text-align:center;padding:8px;}";
  document.head.appendChild(style);

  var bubble = document.createElement("button");
  bubble.id = "va-bubble";
  bubble.setAttribute("aria-label", "Voice assistant খুলুন");
  bubble.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  document.body.appendChild(bubble);

  var panel = document.createElement("div");
  panel.id = "va-panel";
  panel.innerHTML =
    '<div id="va-header">' +
    '<div><div class="va-title">' + AGENT_NAME + '</div><div class="va-sub">Voice Assistant</div></div>' +
    '<button id="va-close" aria-label="বন্ধ করুন">×</button>' +
    "</div>" +
    '<div id="va-body">' +
    '<div id="va-orb"><svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg></div>' +
    '<div id="va-status">শুরু করতে বাটনে ক্লিক করুন</div>' +
    '<button id="va-mic-btn">🎙️ কথা বলা শুরু করুন</button>' +
    "</div>" +
    '<div id="va-footer">Powered by Realtime Voice Agent</div>';
  document.body.appendChild(panel);

  var closeBtn = panel.querySelector("#va-close");
  var micBtn = panel.querySelector("#va-mic-btn");
  var statusEl = panel.querySelector("#va-status");
  var orbEl = panel.querySelector("#va-orb");

  bubble.addEventListener("click", function () {
    panel.classList.toggle("open");
  });
  closeBtn.addEventListener("click", function () {
    panel.classList.remove("open");
    stopSession();
  });

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // ---------- Audio: capture (16kHz PCM16) + playback (24kHz PCM16) ----------
  var ws = null;
  var inputCtx = null;
  var outputCtx = null;
  var micStream = null;
  var processorNode = null;
  var sourceNode = null;
  var sessionActive = false;
  var playHeadTime = 0;

  function base64FromInt16(int16arr) {
    var bytes = new Uint8Array(int16arr.buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function int16FromBase64(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  function floatTo16BitPCM(float32arr) {
    var out = new Int16Array(float32arr.length);
    for (var i = 0; i < float32arr.length; i++) {
      var s = Math.max(-1, Math.min(1, float32arr[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function playPCM16(base64Data, sampleRate) {
    if (!outputCtx) outputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sampleRate });
    var int16 = int16FromBase64(base64Data);
    var float32 = new Float32Array(int16.length);
    for (var i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

    var buffer = outputCtx.createBuffer(1, float32.length, sampleRate);
    buffer.copyToChannel(float32, 0);

    var src = outputCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(outputCtx.destination);

    var now = outputCtx.currentTime;
    if (playHeadTime < now) playHeadTime = now + 0.05;
    src.start(playHeadTime);
    playHeadTime += buffer.duration;

    orbEl.classList.add("speaking");
    src.onended = function () {
      if (outputCtx.currentTime >= playHeadTime - 0.05) orbEl.classList.remove("speaking");
    };
  }

  function stopPlayback() {
    // barge-in: ইউজার কথা বলা শুরু করলে চলমান আউটপুট বন্ধ করা দরকার।
    if (outputCtx) {
      outputCtx.close();
      outputCtx = null;
    }
    playHeadTime = 0;
    orbEl.classList.remove("speaking");
  }

  async function startSession() {
    if (sessionActive) return;
    setStatus("সংযোগ হচ্ছে...");
    micBtn.disabled = true;

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (e) {
      setStatus("মাইক্রোফোন অ্যাক্সেস দরকার 🎙️");
      micBtn.disabled = false;
      return;
    }

    ws = new WebSocket(WS_URL);

    ws.onopen = function () {
      setStatus("কানেক্ট হয়েছে, প্রস্তুত হচ্ছে...");
    };

    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (msg.type === "ready") {
        sessionActive = true;
        micBtn.disabled = false;
        micBtn.textContent = "⏹️ থামান";
        setStatus("শুনছি... কথা বলুন");
        beginMicStreaming();
      } else if (msg.type === "serverContent") {
        var sc = msg.data;
        if (sc.interrupted) {
          stopPlayback();
        }
        if (sc.modelTurn && sc.modelTurn.parts) {
          sc.modelTurn.parts.forEach(function (part) {
            if (part.inlineData && part.inlineData.data) {
              playPCM16(part.inlineData.data, 24000);
            }
          });
        }
        if (sc.turnComplete) {
          setStatus("শুনছি... কথা বলুন");
        }
      } else if (msg.type === "error") {
        setStatus("সমস্যা হয়েছে: " + msg.message);
      } else if (msg.type === "closed") {
        setStatus("সেশন শেষ হয়েছে");
        stopSession();
      }
    };

    ws.onerror = function () {
      setStatus("কানেকশন এরর");
    };

    ws.onclose = function () {
      sessionActive = false;
      micBtn.textContent = "🎙️ কথা বলা শুরু করুন";
    };
  }

  function beginMicStreaming() {
    inputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    sourceNode = inputCtx.createMediaStreamSource(micStream);

    // ScriptProcessorNode deprecated কিন্তু কোনো বিল্ড-টুল ছাড়া single-file widget এ
    // সবচেয়ে সহজ ও সর্বাধিক ব্রাউজার-সাপোর্টেড উপায়। bufferSize 4096 => ~256ms chunk @16kHz.
    processorNode = inputCtx.createScriptProcessor(4096, 1, 1);
    sourceNode.connect(processorNode);
    processorNode.connect(inputCtx.destination);

    var speaking = false;

    processorNode.onaudioprocess = function (e) {
      if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
      var input = e.inputBuffer.getChannelData(0);

      // সাধারণ RMS-ভিত্তিক voice-activity indicator (শুধু UI-র জন্য; বার্জ-ইন Gemini নিজেই হ্যান্ডল করে)
      var sum = 0;
      for (var i = 0; i < input.length; i++) sum += input[i] * input[i];
      var rms = Math.sqrt(sum / input.length);
      if (rms > 0.02 && !speaking) {
        speaking = true;
        orbEl.classList.add("listening");
      } else if (rms <= 0.02 && speaking) {
        speaking = false;
        orbEl.classList.remove("listening");
      }

      var pcm16 = floatTo16BitPCM(input);
      var b64 = base64FromInt16(pcm16);
      ws.send(JSON.stringify({ type: "audio", data: b64 }));
    };
  }

  function stopSession() {
    sessionActive = false;
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
      ws = null;
    }
    if (processorNode) {
      processorNode.disconnect();
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (inputCtx) {
      inputCtx.close();
      inputCtx = null;
    }
    stopPlayback();
    if (micStream) {
      micStream.getTracks().forEach(function (t) {
        t.stop();
      });
      micStream = null;
    }
    micBtn.textContent = "🎙️ কথা বলা শুরু করুন";
    setStatus("শুরু করতে বাটনে ক্লিক করুন");
    orbEl.classList.remove("listening", "speaking");
  }

  micBtn.addEventListener("click", function () {
    if (sessionActive) {
      stopSession();
    } else {
      startSession();
    }
  });
})();
