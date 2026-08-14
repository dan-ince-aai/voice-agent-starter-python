// The page's client. Identical to the one in the JavaScript starter: the
// audio worklets, the websocket session, and the transcript and event panes.
const $ = (id) => document.getElementById(id)
// The rate the API speaks. Both worklets resample, since a browser may
// ignore the rate an AudioContext asks for.
const WIRE_RATE = 24_000
const AGENT = window.AGENT

// Scratch buffers are reused: allocating on the audio thread causes glitches.
const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ratio = sampleRate / ${WIRE_RATE};
      this._pos = 0;
      this._prev = 0;
      this._src = null;
      this._out = null;
    }
    _toPcm(samples, len) {
      const pcm = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return pcm;
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      if (this._ratio === 1) {
        const pcm = this._toPcm(ch, ch.length);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        return true;
      }
      const n = ch.length;
      if (!this._src || this._src.length < n + 1) {
        this._src = new Float32Array(n + 1);
        this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2);
      }
      const src = this._src;
      const out = this._out;
      src[0] = this._prev;
      src.set(ch, 1);
      let outLen = 0;
      let pos = this._pos;
      while (pos < n) {
        const i = Math.floor(pos);
        const frac = pos - i;
        out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac;
        pos += this._ratio;
      }
      this._pos = pos - n;
      this._prev = ch[n - 1];
      if (outLen) {
        const pcm = this._toPcm(out, outLen);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      return true;
    }
  }
  registerProcessor('capture', CaptureProcessor);
`

// A ring buffer rather than one AudioBufferSource per chunk, which drifts and
// clicks under jitter. Posting 'stop' empties it for barge-in.
const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ring = new Float32Array(sampleRate * 30);
      this._writePos = 0;
      this._readPos = 0;
      this._available = 0;
      this._step = ${WIRE_RATE} / sampleRate;
      this._rsPos = 0;
      this._rsPrev = 0;
      // After a gap the speaker sits at zero, so interpolating from the
      // pre-gap _rsPrev would click. Reset it instead.
      this._drained = false;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') {
          this._writePos = this._readPos = this._available = 0;
          this._rsPos = this._rsPrev = 0;
          return;
        }
        const int16 = new Int16Array(e.data);
        // int16[-1] would make _rsPrev NaN, silencing the ring for good.
        if (!int16.length) return;
        if (this._drained) {
          this._rsPrev = 0;
          this._rsPos = 0;
          this._drained = false;
        }
        if (this._step === 1) {
          for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768);
          return;
        }
        const n = int16.length;
        let pos = this._rsPos;
        while (pos < n) {
          const i = Math.floor(pos);
          const frac = pos - i;
          const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768;
          const b = int16[i] / 32768;
          this._push(a + (b - a) * frac);
          pos += this._step;
        }
        this._rsPos = pos - n;
        this._rsPrev = int16[n - 1] / 32768;
      };
    }
    _push(v) {
      if (this._available < this._ring.length) {
        this._ring[this._writePos] = v;
        this._writePos = (this._writePos + 1) % this._ring.length;
        this._available++;
      }
    }
    process(inputs, outputs) {
      const output = outputs[0];
      const out = output[0];
      const cap = this._ring.length;
      for (let i = 0; i < out.length; i++) {
        if (this._available > 0) {
          out[i] = this._ring[this._readPos];
          this._readPos = (this._readPos + 1) % cap;
          this._available--;
        } else {
          out[i] = 0;
          this._drained = true;
        }
      }
      // Mono source, stereo sink.
      for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
      return true;
    }
  }
  registerProcessor('playback', PlaybackProcessor);
`

const blobUrl = (code) =>
  URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))

let ws, captureCtx, playbackCtx, playback, mic, callStart, timer

// --- microphones ---
// Labels stay empty until mic permission is granted, so this runs again after
// getUserMedia.
async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    // Chrome's synthetic entries alias a real device and duplicate it.
    .filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
  const select = $('mic')
  const chosen = select.value
  select.replaceChildren()
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = 'Default microphone'
  select.append(auto)
  inputs.forEach((device, i) => {
    const option = document.createElement('option')
    option.value = device.deviceId
    option.textContent = device.label || `Microphone ${i + 1}`
    select.append(option)
  })
  if (chosen && inputs.some((device) => device.deviceId === chosen)) select.value = chosen
}
listMics()
navigator.mediaDevices?.addEventListener?.('devicechange', listMics)

$('btn').onclick = () => (ws?.readyState <= 1 ? stop() : start())
$('log-toggle').onclick = () => {
  const hidden = document.body.classList.toggle('no-side')
  $('log-toggle').textContent = hidden ? 'Show' : 'Hide'
}

// --- side pane tabs ---
let agentLoaded = false

function showTab(name) {
  for (const tab of ['events', 'agent']) {
    $('tab-' + tab).classList.toggle('on', tab === name)
    $(tab + '-body').hidden = tab !== name
  }
  if (name === 'agent' && !agentLoaded) {
    agentLoaded = true
    fetch('/agent')
      .then((res) => res.json())
      .then((agent) => {
        $('agent-body').replaceChildren()
        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(agent, null, 2)
        $('agent-body').append(pre)
      })
      .catch(() => {
        agentLoaded = false
        $('agent-body').textContent = 'Could not load the agent.'
      })
  }
}
$('tab-events').onclick = () => showTab('events')
$('tab-agent').onclick = () => showTab('agent')

async function addWorklet(ctx, code, name) {
  const url = blobUrl(code)
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new AudioWorkletNode(ctx, name)
}

async function start() {
  $('btn').disabled = true
  $('mic').disabled = true
  setStatus('connecting')

  try {
    // The API key never reaches the page; this token expires in 60 seconds.
    const res = await fetch('/token')
    if (!res.ok) {
      setStatus('error', 'could not mint a token, check the API key')
      reset()
      return
    }
    const { token } = await res.json()

    // Two contexts, created in the click handler so Safari starts them.
    captureCtx = new AudioContext({ sampleRate: WIRE_RATE })
    playbackCtx = new AudioContext({ sampleRate: WIRE_RATE })
    await Promise.all([captureCtx.resume(), playbackCtx.resume()])

    playback = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'playback')
    playback.connect(playbackCtx.destination)

    const deviceId = $('mic').value
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        // A preference, not `exact`: an unplugged device falls back.
        ...(deviceId ? { deviceId } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    listMics()
    const capture = await addWorklet(captureCtx, CAPTURE_WORKLET, 'capture')
    captureCtx.createMediaStreamSource(mic).connect(capture)

    const url = new URL('wss://agents.assemblyai.com/v1/ws')
    url.searchParams.set('token', token)
    ws = new WebSocket(url)
    let ready = false

    // The API takes base64 inside JSON, not binary frames.
    capture.port.onmessage = ({ data }) => {
      if (!ready || ws.readyState !== 1) return
      const bytes = new Uint8Array(data)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      }
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }))
      logEvent('up', 'input.audio')
    }

    // Everything about the agent lives server-side; the session just names it.
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'session.update', session: { agent_id: AGENT.id } }))
      logEvent('up', 'session.update', AGENT.id)
    }

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data)
      switch (msg.type) {
        case 'session.ready':
          ready = true
          callStart = Date.now()
          timer = setInterval(tick, 1000)
          tick()
          setStatus('listening')
          $('btn').disabled = false
          $('btn').textContent = 'End call'
          $('btn').classList.add('live')
          logEvent('down', msg.type, msg.session_id)
          break

        case 'input.speech.started':
          // Barge-in: empty the ring buffer so the agent stops mid-word.
          playback?.port.postMessage('stop')
          setStatus('listening')
          logEvent('down', msg.type)
          break

        case 'reply.started':
          setStatus('speaking')
          logEvent('down', msg.type)
          break

        case 'reply.audio': {
          const raw = atob(msg.data)
          const bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          playback?.port.postMessage(bytes.buffer, [bytes.buffer])
          logEvent('down', msg.type)
          break
        }

        case 'reply.done':
          setStatus('listening')
          if (msg.status === 'interrupted') playback?.port.postMessage('stop')
          logEvent('down', msg.type, msg.status)
          break

        // text is the full transcript so far, so it replaces.
        case 'transcript.user.delta':
          partial('you', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        // delta is the next word only, so it appends.
        case 'transcript.agent.delta':
          logEvent('down', msg.type, msg.delta)
          if (msg.reply_id && msg.reply_id === printedReply) break
          if (msg.reply_id !== liveReply) {
            liveReply = msg.reply_id
            dropPartial('agent')
          }
          partial('agent', appendDelta(partialText.agent || '', msg.delta))
          break

        case 'transcript.user':
          addLine('you', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        case 'transcript.agent':
          printedReply = msg.reply_id ?? printedReply
          addLine('agent', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        case 'tool.call': {
          // http tools run on AssemblyAI's side; no result comes back here.
          const args = JSON.stringify(msg.arguments ?? {})
          addLine('tool', `${msg.name}(${args})`)
          logEvent('down', msg.type, `${msg.name} ${args}`)
          break
        }

        case 'session.ended':
          logEvent('down', msg.type)
          ws.close()
          break

        case 'session.error':
          setStatus('error', msg.message)
          logEvent('down', msg.type, `${msg.code}: ${msg.message}`)
          break

        default:
          logEvent('down', msg.type)
      }
    }

    ws.onclose = () => { setStatus('idle'); reset() }
    ws.onerror = () => { setStatus('error', 'connection failed'); reset() }
  } catch (error) {
    setStatus('error', error.message)
    reset()
  }
}

function stop() {
  // Close cleanly so the session record ends, falling back to the socket.
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'session.end' }))
    logEvent('up', 'session.end')
    const socket = ws
    setTimeout(() => { if (socket.readyState === 1) socket.close() }, 3000)
  } else {
    ws?.close()
  }
  playback?.port.postMessage('stop')
  mic?.getTracks().forEach((track) => track.stop())
  captureCtx?.close()
  playbackCtx?.close()
  captureCtx = playbackCtx = playback = mic = null
  reset()
  setStatus('idle')
}

function reset() {
  clearInterval(timer)
  clearPartials()
  open.forEach((run) => paint(run, true))
  open.clear()
  $('btn').disabled = false
  $('mic').disabled = false
  $('btn').textContent = 'Start call'
  $('btn').classList.remove('live')
}

function setStatus(state, detail) {
  $('status').className = 'status ' + state
  $('status-text').textContent = detail || state
}

// $4.50 an hour, the list price at assemblyai.com/pricing. Billing is per
// session minute, so the running figure is an estimate, not an invoice.
const COST_PER_SECOND = 4.5 / 3600

function tick() {
  const seconds = Math.floor((Date.now() - callStart) / 1000)
  $('elapsed').textContent =
    Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
  $('cost').textContent = '$' + (seconds * COST_PER_SECOND).toFixed(3)
}

// --- transcript ---
const partialText = {}
const partialEl = {}
// The full reply arrives once its audio has been sent, which beats the audio
// playing out, so deltas keep coming after the line is printed. printedReply
// stops them rebuilding the same sentence underneath it.
let liveReply = null
let printedReply = null

// Deltas arrive with a leading space sometimes and without it other times, so
// add one only when neither side has one and the delta is not punctuation.
const ATTACHES_LEFT = /^[.,!?;:%°)\]}…'"’”]/
const NO_SPACE_AFTER = /[([{$\-\/'"‘“]$/

function appendDelta(text, delta) {
  if (!delta) return text
  if (!text) return delta
  if (/^\s/.test(delta) || /\s$/.test(text)) return text + delta
  if (ATTACHES_LEFT.test(delta) || NO_SPACE_AFTER.test(text)) return text + delta
  return text + ' ' + delta
}

function dropPartial(who) {
  partialEl[who]?.remove()
  delete partialEl[who]
  delete partialText[who]
}

function transcriptLine(who, text, cls) {
  const line = document.createElement('div')
  line.className = 'line ' + who + (cls ? ' ' + cls : '')
  const label = document.createElement('span')
  label.className = 'who'
  label.textContent = who === 'agent' ? AGENT.name : who
  const body = document.createElement('span')
  body.className = 'said'
  body.textContent = text
  line.append(label, body)
  return line
}

function clearEmpty(el) {
  const empty = el.querySelector('.empty')
  if (empty) empty.remove()
}

function scroll(el) {
  el.scrollTop = el.scrollHeight
}

function partial(who, text) {
  clearEmpty($('transcript'))
  partialText[who] = text
  if (partialEl[who]) {
    partialEl[who].querySelector('.said').textContent = text
  } else {
    partialEl[who] = transcriptLine(who, text, 'partial')
    $('transcript').append(partialEl[who])
  }
  scroll($('transcript'))
}

function addLine(who, text) {
  clearEmpty($('transcript'))
  dropPartial(who)
  $('transcript').append(transcriptLine(who, text))
  scroll($('transcript'))
}

function clearPartials() {
  for (const who of Object.keys(partialEl)) dropPartial(who)
  liveReply = printedReply = null
}

// --- event log ---
// Audio frames arrive ~190 times a second each way, so these types hold a row
// open and count into it. Both streams run at once, hence a row per key.
const COALESCE = new Set([
  'input.audio',
  'reply.audio',
  'transcript.user.delta',
  'transcript.agent.delta',
])
const open = new Map()

function eventRow(direction, type, detail) {
  const row = document.createElement('div')
  row.className = 'event ' + direction
  const at = document.createElement('span')
  at.className = 'at'
  at.textContent = (callStart ? (Date.now() - callStart) / 1000 : 0).toFixed(1) + 's'
  const arrow = document.createElement('span')
  arrow.className = 'dir'
  arrow.textContent = direction === 'up' ? '↑' : '↓'
  const name = document.createElement('span')
  name.className = 'type'
  name.textContent = type
  const count = document.createElement('span')
  count.className = 'count'
  const info = document.createElement('span')
  info.className = 'detail'
  if (detail) info.textContent = detail
  row.append(at, arrow, name, count, info)
  return row
}

// Ten repaints a second, plus one when the run closes.
function paint(live, final) {
  const now = performance.now()
  if (!final && now - live.painted < 100) return
  live.painted = now
  live.row.querySelector('.count').textContent = live.count > 1 ? '×' + live.count : ''
  if (live.detail) live.row.querySelector('.detail').textContent = live.detail
}

function logEvent(direction, type, detail) {
  const log = $('events-body')
  clearEmpty(log)
  const key = direction + ' ' + type
  const live = open.get(key)
  if (live) {
    live.count += 1
    if (detail) live.detail = detail
    paint(live)
    return
  }
  // A real event closes the open runs, so the next burst starts a new row.
  if (!COALESCE.has(type)) {
    open.forEach((run) => paint(run, true))
    open.clear()
  }
  // Only follow the tail if the reader is there.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  const row = eventRow(direction, type, detail)
  log.append(row)
  while (log.children.length > 400) log.firstChild.remove()
  if (COALESCE.has(type)) open.set(key, { row, count: 1, detail, painted: 0 })
  if (atBottom) scroll(log)
}
