require('dotenv').config({ path: __dirname + '/.env' })
const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const express = require('express')
const nodemailer = require('nodemailer')
const fs = require('fs')
const path = require('path')
const cors = require('cors')

const PORT    = process.env.WA_SIDECAR_PORT || 3003
const LAB_JID = `${process.env.LAB_WA_NUMBER}@s.whatsapp.net`

let sock     = null
let latestQR = null
let isReady  = false

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

// ── WhatsApp socket ────────────────────────────────────────────────────────────

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

// ── Email ──────────────────────────────────────────────────────────────────────

function buildEmailHtml({ name, age, sex, phone, tests, notes, bookingRef, date, time }) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;padding:0 16px;">
    <div style="background:#111416;border-radius:20px;border:1px solid rgba(255,255,255,0.08);padding:40px;">

      <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#06b6d4;margin:0 0 28px;">
        Global Diagnostic Laboratories Ltd.
      </p>

      <h1 style="color:#ffffff;font-size:26px;font-weight:600;margin:0 0 10px;letter-spacing:-0.03em;line-height:1.15;">
        Booking received.
      </h1>
      <p style="color:rgba(255,255,255,0.5);font-size:15px;margin:0 0 28px;line-height:1.65;">
        Hi ${name}, we've received your request and will call you shortly to confirm your appointment.
      </p>

      <div style="background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.25);border-radius:12px;padding:18px 22px;margin-bottom:24px;text-align:center;">
        <p style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#06b6d4;margin:0 0 6px;">Your Booking Reference</p>
        <p style="font-size:26px;font-weight:800;letter-spacing:0.1em;color:#06b6d4;margin:0 0 6px;">${bookingRef}</p>
        <p style="font-size:11px;color:rgba(255,255,255,0.35);margin:0;">Quote this when you arrive at the lab.</p>
      </div>

      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:22px;margin-bottom:16px;">
        <p style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#06b6d4;margin:0 0 16px;">Your Details</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="color:rgba(255,255,255,0.45);font-size:13px;padding:5px 0;width:100px;">Name</td>
            <td style="color:#fff;font-size:13px;font-weight:500;padding:5px 0;">${name}</td>
          </tr>
          <tr>
            <td style="color:rgba(255,255,255,0.45);font-size:13px;padding:5px 0;">Age / Sex</td>
            <td style="color:#fff;font-size:13px;font-weight:500;padding:5px 0;">${age} · ${sex}</td>
          </tr>
          <tr>
            <td style="color:rgba(255,255,255,0.45);font-size:13px;padding:5px 0;">Phone</td>
            <td style="color:#fff;font-size:13px;font-weight:500;padding:5px 0;">${phone}</td>
          </tr>
          <tr>
            <td style="color:rgba(255,255,255,0.45);font-size:13px;padding:5px 0;">Visit</td>
            <td style="color:#fff;font-size:13px;font-weight:500;padding:5px 0;">${date} · ${time}</td>
          </tr>
        </table>
      </div>

      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:22px;margin-bottom:${notes ? '16px' : '0'};">
        <p style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#06b6d4;margin:0 0 14px;">
          Tests Requested (${tests.length})
        </p>
        ${tests.map(t => `
          <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:9px;">
            <span style="color:#06b6d4;flex-shrink:0;margin-top:1px;">•</span>
            <span style="color:#fff;font-size:13px;line-height:1.5;">${t}</span>
          </div>
        `).join('')}
      </div>

      ${notes ? `
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:22px;margin-top:16px;">
        <p style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#06b6d4;margin:0 0 10px;">Notes</p>
        <p style="color:rgba(255,255,255,0.7);font-size:13px;line-height:1.65;margin:0;">${notes}</p>
      </div>
      ` : ''}

      <p style="color:rgba(255,255,255,0.28);font-size:12px;line-height:1.7;margin:28px 0 8px;">
        We'll call you at <strong style="color:rgba(255,255,255,0.45);">${phone}</strong> to confirm.
        Questions? Call us at +234 701 396 6751.
      </p>
      <p style="color:rgba(255,255,255,0.18);font-size:11px;margin:0;">82 Ogunlana Drive, Surulere, Lagos, Nigeria</p>
    </div>
  </div>
</body>
</html>`
}

// ── Express ────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }))

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

// ── /send — internal WA message (called by old route, keep for anything else) ──

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

// ── /booking — called directly by the frontend ─────────────────────────────────

app.post('/booking', async (req, res) => {
  try {
    const { name, age, sex, phone, email, tests, notes, date, time } = req.body

    if (!name || !phone || !tests?.length)
      return res.status(400).json({ error: 'Missing required fields' })

    if (date && new Date(date + 'T00:00:00').getDay() === 0)
      return res.status(400).json({ error: 'The laboratory is closed on Sundays. Please choose Monday through Saturday.' })

    const bookingRef = 'GDL-' + Math.random().toString(36).substring(2, 8).toUpperCase()
    const testList = tests.map(t => `• ${t}`).join('\n')

    const waMessage = [
      `🧪 *New Booking — GDL*`,
      `*Ref:* ${bookingRef}`,
      ``,
      `*Name:* ${name}`,
      `*Age:* ${age}`,
      `*Sex:* ${sex}`,
      `*Phone:* ${phone}`,
      email ? `*Email:* ${email}` : null,
      ``,
      `*Preferred Visit:*`,
      `📅 ${date}  🕐 ${time}`,
      ``,
      `*Tests (${tests.length}):*`,
      testList,
      notes ? `\n*Notes:* ${notes}` : null,
      ``,
      `_via gdl.com_`,
    ].filter(Boolean).join('\n')

    if (!sock || !isReady) {
      enqueue(waMessage)
    } else {
      try {
        await sock.sendMessage(LAB_JID, { text: waMessage })
      } catch {
        enqueue(waMessage)
      }
    }

    if (email) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      })
      await transporter.sendMail({
        from: `"Global Diagnostic Laboratories" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: 'Booking received — Global Diagnostic Laboratories',
        html: buildEmailHtml({ name, age, sex, phone, tests, notes, bookingRef, date, time }),
      })
    }

    res.json({ success: true, bookingRef })
  } catch (err) {
    console.error('Booking error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.listen(PORT, () => console.log(`WA sidecar listening on :${PORT}`))