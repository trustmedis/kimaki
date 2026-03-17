import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type APIMessage,
  type TextChannel,
} from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { startDiscordBot } from './discord-bot.js'
import { closeDatabase, initDatabase, setBotToken } from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { stopOpencodeServer } from './opencode.js'
import { chooseLockPort } from './test-utils.js'

const e2eTest = describe

const GUILD_OWNER_ID = '200000000000000700'
const TEST_USER_ID = '200000000000000701'
const GENERAL_CHANNEL_ID = '200000000000000702'
const THREAD_PARENT_CHANNEL_ID = '200000000000000703'

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'non-project-routing-e2e')
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  return { root, dataDir }
}

function createDiscordJsClient({ restUrl }: { restUrl: string }) {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
    rest: {
      api: restUrl,
      version: '10',
    },
  })
}

async function assertNoBotMessages({
  getMessages,
  botUserId,
  timeoutMs = 250,
}: {
  getMessages: () => Promise<APIMessage[]>
  botUserId: string
  timeoutMs?: number
}) {
  const start = Date.now()
  let lastMessages: APIMessage[] = []

  while (Date.now() - start < timeoutMs) {
    lastMessages = await getMessages()
    const botMessage = lastMessages.find((message) => {
      return message.author.id === botUserId
    })
    if (botMessage) {
      throw new Error(
        `Expected no bot messages, but saw: ${botMessage.content || '[embed/attachment only]'}`,
      )
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
}

e2eTest('non-project message routing', () => {
  let directories: ReturnType<typeof createRunDirectories>
  let discord: DigitalDiscord
  let botClient: Client

  beforeAll(async () => {
    directories = createRunDirectories()
    const lockPort = chooseLockPort({ key: GENERAL_CHANNEL_ID })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    setDataDir(directories.dataDir)

    const digitalDiscordDbPath = path.join(
      directories.dataDir,
      'digital-discord.db',
    )

    discord = new DigitalDiscord({
      guild: {
        name: 'Non Project Routing Guild',
        ownerId: GUILD_OWNER_ID,
      },
      channels: [
        {
          id: GENERAL_CHANNEL_ID,
          name: 'general',
          type: ChannelType.GuildText,
        },
        {
          id: THREAD_PARENT_CHANNEL_ID,
          name: 'random',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: GUILD_OWNER_ID,
          username: 'guild-owner',
        },
        {
          id: TEST_USER_ID,
          username: 'outside-project-user',
        },
      ],
      dbUrl: `file:${digitalDiscordDbPath}`,
    })

    await discord.start()

    const dbPath = path.join(directories.dataDir, 'discord-sessions.db')
    const hranaResult = await startHranaServer({ dbPath })
    if (hranaResult instanceof Error) {
      throw hranaResult
    }
    process.env['KIMAKI_DB_URL'] = hranaResult
    await initDatabase()
    await setBotToken(discord.botUserId, discord.botToken)

    botClient = createDiscordJsClient({ restUrl: discord.restUrl })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })
  }, 60_000)

  afterAll(async () => {
    if (botClient) {
      botClient.destroy()
    }

    await stopOpencodeServer()
    await Promise.all([
      closeDatabase().catch(() => {
        return
      }),
      stopHranaServer().catch(() => {
        return
      }),
      discord?.stop().catch(() => {
        return
      }),
    ])

    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    if (directories) {
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  }, 10_000)

  test('stays silent in an unmapped text channel for a user without Kimaki access', async () => {
    await discord.channel(GENERAL_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'outside project text',
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })

    expect(await discord.channel(GENERAL_CHANNEL_ID).text()).toMatchInlineSnapshot(`
      "--- from: user (outside-project-user)
      outside project text"
    `)

    await assertNoBotMessages({
      getMessages: () => {
        return discord.channel(GENERAL_CHANNEL_ID).getMessages()
      },
      botUserId: discord.botUserId,
    })
  })

  test('stays silent in a thread whose parent channel is not mapped to a project', async () => {
    const fetchedChannel = await botClient.channels.fetch(THREAD_PARENT_CHANNEL_ID)
    if (!fetchedChannel || fetchedChannel.type !== ChannelType.GuildText) {
      throw new Error('Expected a text channel for thread routing test')
    }
    const textChannel = fetchedChannel as TextChannel

    const thread = await textChannel.threads.create({
      name: 'outside-project-thread',
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    })
    await thread.members.add(TEST_USER_ID)

    await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({
      content: 'outside project thread',
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })

    expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
      "--- from: user (outside-project-user)
      outside project thread"
    `)

    await assertNoBotMessages({
      getMessages: () => {
        return discord.thread(thread.id).getMessages()
      },
      botUserId: discord.botUserId,
    })
  })
})
