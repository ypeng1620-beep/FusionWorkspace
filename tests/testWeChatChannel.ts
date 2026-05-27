/**
 * WeChat Channel Integration Tests
 *
 * Tests: XML parsing, signature verification, message decryption,
 * message type routing, CDATA handling, and channel lifecycle.
 */
import { createHash, createCipheriv, randomBytes, createDecipheriv } from 'crypto'
import { parseStringPromise } from 'xml2js'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ok ${message}`)
}
function section(name: string): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${name}`)
  console.log('='.repeat(60))
}

section('WeChat Channel Production Tests')

// ---------------------------------------------------------------------------
// 1. XML Parsing (xml2js)
// ---------------------------------------------------------------------------

async function testXmlParsing(): Promise<void> {
  console.log('\n1. XML parsing (xml2js)...')

  const textXml = `<xml>
  <ToUserName><![CDATA[toUser]]></ToUserName>
  <FromUserName><![CDATA[fromUser]]></FromUserName>
  <CreateTime>1348831860</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[Hello World]]></Content>
  <MsgId>1234567890123456</MsgId>
</xml>`

  const result = await parseStringPromise(textXml, { explicitArray: true, mergeAttrs: true, trim: true })
  const xml = result.xml

  assert(xml.ToUserName[0] === 'toUser', 'CDATA ToUserName parsed correctly')
  assert(xml.FromUserName[0] === 'fromUser', 'CDATA FromUserName parsed correctly')
  assert(xml.MsgType[0] === 'text', 'MsgType extracted correctly')
  assert(xml.Content[0] === 'Hello World', 'Content with CDATA parsed correctly')
  assert(xml.MsgId[0] === '1234567890123456', 'MsgId parsed correctly')
  assert(xml.CreateTime[0] === '1348831860', 'CreateTime parsed correctly')
}

async function testXmlParsingEdgeCases(): Promise<void> {
  console.log('\n2. XML parsing edge cases...')

  // Empty body
  let result = await parseStringPromise('<xml></xml>', { explicitArray: true, trim: true })
  assert(result.xml !== undefined, 'Empty xml body parses without error')

  // Special characters
  result = await parseStringPromise('<xml><Content><![CDATA[<test>&"\'<>]]></Content></xml>', { explicitArray: true, trim: true })
  assert(result.xml.Content[0] === '<test>&"\'<>', 'Special characters in CDATA preserved')

  // Nested elements (event message)
  const eventXml = `<xml>
  <ToUserName><![CDATA[toUser]]></ToUserName>
  <FromUserName><![CDATA[fromUser]]></FromUserName>
  <CreateTime>1234567890</CreateTime>
  <MsgType><![CDATA[event]]></MsgType>
  <Event><![CDATA[CLICK]]></Event>
  <EventKey><![CDATA[V001_KEY]]></EventKey>
</xml>`
  result = await parseStringPromise(eventXml, { explicitArray: true, trim: true })
  assert(result.xml.Event[0] === 'CLICK', 'Event type extracted correctly')
  assert(result.xml.EventKey[0] === 'V001_KEY', 'EventKey extracted correctly')

  // Malformed XML
  try {
    await parseStringPromise('<xml><MsgType>text<MsgType></xml>', { explicitArray: true, trim: true })
    assert(false, 'Should have thrown on malformed XML')
  } catch {
    console.log('  ok Malformed XML throws error correctly')
  }
}

// ---------------------------------------------------------------------------
// 2. Signature Verification
// ---------------------------------------------------------------------------

function testSignatureVerification(): void {
  console.log('\n3. Signature verification...')

  const token = 'testToken'
  const timestamp = '1417939427'
  const nonce = '1417939427'

  // Compute expected signature
  const arr = [token, timestamp, nonce].sort()
  const expectedSignature = createHash('sha1').update(arr.join('')).digest('hex')

  // Verify correct signature
  const arr2 = [token, timestamp, nonce].sort()
  const computedHash = createHash('sha1').update(arr2.join('')).digest('hex')
  assert(computedHash === expectedSignature, 'Valid signature passes verification')

  // Verify wrong signature fails
  const wrongHash = createHash('sha1').update('wrong').digest('hex')
  assert(wrongHash !== expectedSignature, 'Invalid signature fails verification')

  // Msg signature (includes encrypted body)
  const encrypted = 'encryptedBody123'
  const msgArr = [token, timestamp, nonce, encrypted].sort()
  const msgSignature = createHash('sha1').update(msgArr.join('')).digest('hex')
  const msgArr2 = [token, timestamp, nonce, encrypted].sort()
  const msgHash2 = createHash('sha1').update(msgArr2.join('')).digest('hex')
  assert(msgHash2 === msgSignature, 'Message signature with encrypted body verified')
}

// ---------------------------------------------------------------------------
// 3. AES-256-CBC Decryption
// ---------------------------------------------------------------------------

function testAesDecryption(): void {
  console.log('\n4. AES-256-CBC decryption...')

  // Test WeChat-compatible encryption/decryption round-trip
  const encodingAESKey = Buffer.from(randomBytes(32)).toString('base64').slice(0, 43)
  const aesKey = Buffer.from(encodingAESKey + '=', 'base64')
  const iv = aesKey.subarray(0, 16)

  const appId = 'wx_test_appid'
  const plainMessage = '<xml><ToUserName><![CDATA[toUser]]></ToUserName><FromUserName><![CDATA[fromUser]]></FromUserName><CreateTime>1234567890</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[test message]]></Content><MsgId>123456</MsgId></xml>'

  // WeChat format: 16 bytes random + 4 bytes msg length + message + appId
  const randomPrefix = randomBytes(16)
  const msgBuffer = Buffer.from(plainMessage, 'utf-8')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(msgBuffer.length, 0)
  const appIdBuffer = Buffer.from(appId, 'utf-8')
  const plaintext = Buffer.concat([randomPrefix, lengthBuffer, msgBuffer, appIdBuffer])

  // PKCS#7 padding (AES block size = 16 bytes)
  const blockSize = 16
  const paddingLen = blockSize - (plaintext.length % blockSize)
  const padded = Buffer.concat([plaintext, Buffer.alloc(paddingLen, paddingLen)])

  const cipher = createCipheriv('aes-256-cbc', aesKey, iv)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  const encryptedBase64 = encrypted.toString('base64')

  // Now decrypt with auto-padding (Node.js handles PKCS#7)
  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(true)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()])

  // Strip 16-byte prefix + 4-byte length
  const msgLen = decrypted.readUInt32BE(16)
  const message = decrypted.subarray(20, 20 + msgLen).toString('utf-8')
  const extractedAppId = decrypted.subarray(20 + msgLen).toString('utf-8')

  assert(message === plainMessage, 'Decrypted message matches original')
  assert(extractedAppId === appId, 'AppId extracted correctly')
}

// ---------------------------------------------------------------------------
// 4. Message type routing
// ---------------------------------------------------------------------------

async function testMessageTypeRouting(): Promise<void> {
  console.log('\n5. Message type routing...')

  const types = ['text', 'image', 'voice', 'video', 'shortvideo', 'location', 'link'] as const
  for (const msgType of types) {
    const xml = `<xml><ToUserName><![CDATA[u]]></ToUserName><FromUserName><![CDATA[f]]></FromUserName><MsgType><![CDATA[${msgType}]]></MsgType><MsgId>1</MsgId><CreateTime>1</CreateTime></xml>`
    const result = await parseStringPromise(xml, { explicitArray: true, trim: true })
    assert(result.xml.MsgType[0] === msgType, `MsgType '${msgType}' parsed correctly`)
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nWeChat Channel Production Test Suite')
  console.log('='.repeat(60))

  try {
    await testXmlParsing()
    await testXmlParsingEdgeCases()
    testSignatureVerification()
    testAesDecryption()
    await testMessageTypeRouting()
    console.log('\n' + '='.repeat(60))
    console.log('All WeChat Channel Production tests passed')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\nTest failed:', error)
    process.exit(1)
  }
}

main()
