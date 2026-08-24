require('dotenv').config({ path: __dirname + '/.env' })
const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const express = require('express')

const PORT    = process.env.WA_SIDECAR_PORT || 3003
const LAB_JID = `${process.env.LAB_WA_NUMBER}@s.whatsapp.net`

let sock      = null
let latestQR  = null

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
      console.log('✅ WhatsApp connected')
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed. Reconnecting:', shouldReconnect)
      if (shouldReconnect) startSock()
    }
  })
}

startSock()

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
  if (!sock)    return res.status(503).json({ error: 'WhatsApp not connected' })

  try {
    await sock.sendMessage(LAB_JID, { text: message })
    res.json({ success: true })
  } catch (err) {
    console.error('Send error:', err)
    res.status(500).json({ error: 'Failed to send' })
  }
})

app.listen(PORT, () => console.log(`WA sidecar listening on :${PORT}`))