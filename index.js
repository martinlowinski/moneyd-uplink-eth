'use strict'

const {
  AssetUnit,
  convert,
  eth,
  gwei,
} = require('@kava-labs/crypto-rate-utils')
const { randomBytes, createHmac } = require('crypto')
const inquirer = require('inquirer')
const connectorList = require('./connector_list.json')
const parentBtpHmacKey = 'parent_btp_uri'

const base64url = buf => buf
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

async function configure ({ testnet, advanced }) {
  const servers = connectorList[testnet ? 'test' : 'live']
  const defaultParent = servers[Math.floor(Math.random() * servers.length)]
  const res = {}
  const fields = [{
    type: 'input',
    name: 'privateKey',
    message: 'Ethereum private key:'
  }, {
    type: 'input',
    name: 'parent',
    message: 'BTP host of parent connector:',
    default: defaultParent
  }, {
    type: 'input',
    name: 'name',
    message: 'Name to assign to this connection:',
    default: base64url(randomBytes(32))
  }]

  for (const field of fields) {
    res[field.name] = (await inquirer.prompt(field))[field.name]
  }

  // For now, use HTTP-RPC; Websocket provider has too many issues
  const ethereumProvider = testnet
    ? 'https://kovan.infura.io/bXIbx0x6ofEuDANTSeKI'
    : 'https://mainnet.infura.io/bXIbx0x6ofEuDANTSeKI'

  // Create btp server uri for upstream
  const btpSecret = hmac(hmac(parentBtpHmacKey, res.parent + res.name), res.privateKey).toString('hex')
  const btpServer = 'btp+wss://' + res.name + ':' + btpSecret + '@' + res.parent

  return {
    relation: 'parent',
    plugin: require.resolve('ilp-plugin-ethereum'),
    assetCode: 'ETH',
    assetScale: 9,
    sendRoutes: false,
    receiveRoutes: false,
    options: {
      role: 'client',
      ethereumPrivateKey: res.privateKey,
      ethereumProvider,
      // Open channels for ~$2 by default
      outgoingChannelAmount: convert(gwei(10000000), eth()),
      balance: {
        // Fulfill up to ~$1 without receiving money
        maximum: convert(gwei(5000000), eth()),
        // Stay prefunded by ~40¢
        settleTo: convert(gwei(2000000), eth()),
        // Settle up on every packet
        settleThreshold: convert(gwei(2000000), eth())
      },
      server: btpServer
    }
  }
}

const hmac = (key, message) =>
  createHmac('sha256', key)
    .update(message)
    .digest()

module.exports = {
  configure,
  commands: []
}
