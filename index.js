'use strict'
const crypto = require('crypto')
const table = require('good-table')
const chalk = require('chalk')
const inquirer = require('inquirer')
const Plugin = require('ilp-plugin-ethereum-asym-client')
const connectorList = require('./connector_list.json')
const parentBtpHmacKey = 'parent_btp_uri'

async function configure ({ testnet, advanced }) {
  const servers = connectorList[testnet ? 'test' : 'live']
  const defaultParent = servers[Math.floor(Math.random() * servers.length)]
  const res = {}
  const fields = [{
    type: 'input',
    name: 'account',
    message: 'Ethereum account:'
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
    default: ''
  }]
  for (const field of fields) {
    res[field.name] = (await inquirer.prompt(field))[field.name]
  }

  const btpName = res.name || ''
  const btpSecret = hmac(hmac(parentBtpHmacKey, res.parent + btpName), res.provider).toString('hex')
  const btpServer = 'btp+wss://' + btpName + ':' + btpSecret + '@' + res.parent
  return {
    relation: 'parent',
    plugin: require.resolve('ilp-plugin-ethereum-asym-client'),
    assetCode: 'ETH',
    assetScale: 18,
    sendRoutes: false,
    receiveRoutes: false,
    balance: {
      minimum: '-Infinity',
      maximum: '20000000000000000',
      settleThreshold: '5000000000000000',
      settleTo: '10000000000000000'
    },
    options: {
      server: btpServer,
      account: res.account,
      db: 'machinomy_db',
      provider: res.provider
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
