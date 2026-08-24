require('dotenv').config({ path: __dirname + '/.env' })  // 👈
const makeWASocket    = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom }        = require('@hapi/boom')
const qrcode          = require('qrcode-terminal')
const express         = require('express')

const PORT      = process.env.WA_SIDECAR_PORT || 3001
const LAB_JID   = `${process.env.LAB_WA_NUMBER}@s.whatsapp.net`

let sock = null

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({ auth: state, printQRInTerminal: false })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Scan this QR with WhatsApp:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
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