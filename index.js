'use strict'
const Web3 = require('web3')
const crypto = require('crypto')
const table = require('good-table')
const chalk = require('chalk')
const inquirer = require('inquirer')
const Plugin = require('ilp-plugin-ethereum-asym-server')
const connectorList = require('./connector_list.json')
const util = require('util')
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
    name: 'account',
    message: 'Ethereum account (secret):'
  }, {
    type: 'input',
    name: 'provider',
    message: 'Ethereum provider:'
  }, {
    type: 'input',
    name: 'parent',
    message: 'BTP host of parent connector:',
    default: defaultParent
  }, {
    type: 'input',
    name: 'name',
    message: 'Name to assign to this channel:',
    default: base64url(crypto.randomBytes(32)) 
  }]
  for (const field of fields) {
    res[field.name] = (await inquirer.prompt(field))[field.name]
  }

  if (res.provider.toLowerCase() !== 'web3') {
    throw new Error('This provider is not supported.')
  }

  // create web3 provider, and add secret
  const web3 = new Web3('wss://mainnet.infura.io/ws')
  web3.eth.accounts.wallet.add(res.account)
  const ethereumAddress = web3.eth.accounts.wallet[0].address
  console.log(ethereumAddress)

  // create btp server uri for upstream
  const btpName = res.name || ''
  const btpSecret = hmac(hmac(parentBtpHmacKey, res.parent + btpName), res.provider).toString('hex')
  const btpServer = 'btp+wss://' + btpName + ':' + btpSecret + '@' + res.parent

  return {
    relation: 'parent',
    plugin: require.resolve('ilp-plugin-ethereum-asym-server'),
    assetCode: 'ETH',
    assetScale: 9,
    sendRoutes: false,
    receiveRoutes: false,
    options: {
      role: 'client',
      ethereumAddress,
      web3: util.inspect(web3),
      balance: {
        minimum: '-Infinity',
        maximum: '20000000',
        settleThreshold: '5000000',
        settleTo: '10000000'
      },
      server: btpServer
    }
  }
}

const commands = [
  {
    command: 'info',
    describe: 'Get info about your ETH account and payment channels',
    builder: {},
    handler: (config, argv) => makeUplink(config).printChannels()
  },
  {
    command: 'cleanup',
    describe: 'Clean up unused payment channels',
    builder: {},
    handler: (config, argv) => makeUplink(config).cleanupChannels()
  },
  {
    command: 'topup',
    describe: 'Pre-fund your balance with connector',
    builder: {
      amount: {
        description: 'amount to send to connector',
        demandOption: true
      }
    },
    handler: (config, {amount}) => makeUplink(config).topup(amount)
  }
]

function makeUplink (config) {
  return new EthUplink(config)
}

class EthUplink {
  constructor (config) {
    this.config = config
    this.pluginOpts = config.options
    this.plugin = null
    this.subscribed = false
  }

  async printChannels () {
    await this._printChannels(await this._listChannels())
    await this._close()
  }

  async _printChannels (channels) {
    console.log(chalk.green('account:'), this.pluginOpts.account)
    const balance = await this.plugin._web3.eth.getBalance(this.pluginOpts.account)
    console.log(chalk.green('balance:'), balance.toString() + ' WEI')
    if (!channels.length) {
      return console.error('No channels found')
    }
    console.log(table([
      [ chalk.green('index'),
        chalk.green('receiver'),
        chalk.green('spent'),
        chalk.green('value'),
        chalk.green('state') ],
      ...channels.map(formatChannelToRow)
    ]))
  }

  async cleanupChannels () {
    const api = await this._api()
    const allChannels = await this._listChannels()
    await this._printChannels(allChannels)
    if (!allChannels.length) return
    const result = await inquirer.prompt({
      type: 'checkbox',
      name: 'marked',
      message: 'Select channels to close:',
      choices: allChannels.map((_, i) => i.toString())
    })
    const channels = result.marked.map((index) => allChannels[+index])

    for (const channel of channels) {
      console.log('Closing channel ' + channel.channelId)
      try {
        await api.close(channel.channelId)
      } catch (err) {
        console.error('Warning for channel ' + channel.channelId + ':', err.message)
      }
    }
    await this._close()
  }

  async _listChannels () {
    const api = await this._api()
    console.log('fetching channels...')
    return api.channels()
  }

  async topup (amount) {
    const plugin = new Plugin(this.pluginOpts)
    await plugin.connect()
    await plugin.sendMoney(amount)
    await plugin.disconnect()
  }

  async _api () {
    if (!this.plugin) {
      this.plugin = new Plugin(this.pluginOpts)
      await this.plugin.connect()
    }
    return this.plugin._machinomy
  }

  async _close () {
    if (this.plugin) {
      await this.plugin.disconnect()
    }
  }
}

const channelStates = {
  0: 'open',
  1: 'settling',
  2: 'settled'
}

function formatChannelToRow (c, i) {
  return [
    String(i),
    c.receiver,
    c.spent.toString(),
    c.value.toString(),
    channelStates[c.state] || 'unknown'
  ]
}

function hmac (key, message) {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

module.exports = {
  configure,
  commands
}
