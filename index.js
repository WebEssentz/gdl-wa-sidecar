require('dotenv').config({ path: __dirname + '/.env' })
const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const express = require('express')
const fs = require('fs')
const path = require('path')

const PORT    = process.env.WA_SIDECAR_PORT || 3003
const LAB_JID = `${process.env.LAB_WA_NUMBER}@s.whatsapp.net`

let sock      = null
let latestQR  = null
let isReady   = false

const QUEUE_FILE = path.join(__dirname, 'message_queue.json')

// ── Queue helpers ──────────────────────────────────────────────────────────────

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return []
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
  } catch { return [] }
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2))
}

function enqueue(message) {
  const queue = loadQueue()
  queue.push({ message, timestamp: Date.now(), attempts: 0 })
  saveQueue(queue)
  console.log(`📥 Message queued (${queue.length} pending)`)
}

async function flushQueue() {
  const queue = loadQueue()
  if (!queue.length) return
  console.log(`🔄 Flushing ${queue.length} queued messages...`)

  const failed = []
  for (const item of queue) {
    try {
      await sock.sendMessage(LAB_JID, { text: item.message })
      console.log('✅ Queued message sent')
    } catch (err) {
      item.attempts++
      if (item.attempts < 10) failed.push(item)
      else console.log('🗑️  Dropped message after 10 attempts')
    }
  }

  saveQueue(failed)
  if (failed.length) console.log(`⚠️  ${failed.length} messages still pending`)
}

// ── Socket ─────────────────────────────────────────────────────────────────────

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({ auth: state, printQRInTerminal: false })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = await QRCode.toDataURL(qr)
      console.log('📱 QR ready — visit /qr on your domain')
    }

    if (connection === 'open') {
      latestQR = null
      isReady = true
      console.log('✅ WhatsApp connected')
      await flushQueue()
    }

    if (connection === 'close') {
      isReady = false
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed. Reconnecting:', shouldReconnect)
      if (shouldReconnect) startSock()
    }
  })
}

startSock()

// ── Express ────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

// QR route — no auth needed, remove after first scan
app.get('/qr', (_, res) => {
  if (!latestQR) return res.send('<p>No QR available — already connected or not ready yet. Refresh in a few seconds.</p>')
  res.send(`
    <html><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;">
      <div style="text-align:center">
        <p style="color:#06b6d4;font-family:sans-serif;margin-bottom:16px;">Scan with WhatsApp</p>
        <img src="${latestQR}" style="width:280px;border-radius:12px;" />
        <p style="color:rgba(255,255,255,0.3);font-family:sans-serif;font-size:12px;margin-top:12px;">Refresh if expired</p>
      </div>
    </body></html>
  `)
})

// Secret guard for all routes below
app.use((req, res, next) => {
  if (req.headers['x-sidecar-secret'] !== process.env.WA_SIDECAR_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

app.post('/send', async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error: 'Missing message' })

  if (!sock || !isReady) {
    enqueue(message)
    return res.json({ success: true, queued: true })
  }

  try {
    await sock.sendMessage(LAB_JID, { text: message })
    res.json({ success: true, queued: false })
  } catch (err) {
    console.error('Send error:', err)
    enqueue(message)
    res.json({ success: true, queued: true })
  }
})

app.listen(PORT, () => console.log(`WA sidecar listening on :${PORT}`))