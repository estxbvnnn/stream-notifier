require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  LIVE_ROLE_ID,
  CLIENT_ID,
  GUILD_ID,
  DEBUG_CHANNEL_ID,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
} = process.env;
// Si no seteás un canal de bienvenida aparte, usa el mismo canal de avisos de stream.
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || CHANNEL_ID;
// Opcional: si se setea, solo notifica cuando la categoría de Twitch coincide (case-insensitive).
const TWITCH_CATEGORY_FILTER = process.env.TWITCH_CATEGORY_FILTER?.trim() || null;

const REQUIRED_ENV = {
  DISCORD_TOKEN,
  CHANNEL_ID,
  LIVE_ROLE_ID,
  CLIENT_ID,
  GUILD_ID,
  DEBUG_CHANNEL_ID,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
};
const missing = Object.entries(REQUIRED_ENV)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length > 0) {
  console.error(`Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const WATCHLIST_PATH = path.join(DATA_DIR, 'watchlist.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// watchlist: Map<discordUserId, twitchLogin>
function loadWatchlist() {
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    if (Array.isArray(raw)) return new Map(); // formato viejo (solo IDs), se resetea
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function saveWatchlist() {
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(Object.fromEntries(watchlist)));
}

const watchlist = loadWatchlist();
// IDs de Discord ya marcados "en vivo", para no reasignar el rol / reenviar
// el aviso mientras dura el mismo stream.
const liveNow = new Set();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Red de seguridad: un error suelto en cualquier lado no debe tirar abajo el proceso entero.
client.on('error', (err) => console.error('Error del cliente de Discord:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

let guild = null;

// ---------- Twitch API ----------

let twitchToken = null;
let twitchTokenExpiry = 0;

async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiry - 60_000) return twitchToken;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    throw new Error(`Twitch token error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpiry = Date.now() + data.expires_in * 1000;
  return twitchToken;
}

async function fetchLiveStreams(logins) {
  if (logins.length === 0) return new Map();

  const token = await getTwitchToken();
  const params = new URLSearchParams();
  logins.forEach((login) => params.append('user_login', login.toLowerCase()));

  const res = await fetch(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    twitchToken = null; // token vencido/inválido, forzar refresh y reintentar una vez
    return fetchLiveStreams(logins);
  }
  if (!res.ok) {
    throw new Error(`Twitch streams error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const map = new Map();
  for (const stream of data.data) {
    map.set(stream.user_login.toLowerCase(), stream);
  }
  return map;
}

const POLL_INTERVAL_MS = 60_000;

// Se corre una sola vez al arrancar: marca como "ya en vivo" a quien ya estaba
// streameando ANTES de este reinicio, sin mandar el aviso ni tocar roles.
// Sin esto, cada reinicio del bot (ej. por una actualización) reenviaría el
// @everyone de gente que sigue con el mismo stream de antes.
async function initialSync() {
  if (watchlist.size === 0 || !guild) return;
  try {
    const liveMap = await fetchLiveStreams([...watchlist.values()]);
    for (const [discordId, twitchLogin] of watchlist) {
      const stream = liveMap.get(twitchLogin.toLowerCase());
      const matchesCategory =
        !TWITCH_CATEGORY_FILTER ||
        (stream && stream.game_name?.toLowerCase() === TWITCH_CATEGORY_FILTER.toLowerCase());
      if (stream && matchesCategory) {
        liveNow.add(discordId);
        console.log(`[sync inicial] ${twitchLogin} ya estaba en vivo antes de este reinicio, no reaviso.`);
      }
    }
  } catch (err) {
    console.error('Error en la sincronización inicial con Twitch:', err);
  }
}

async function pollTwitch() {
  if (watchlist.size === 0 || !guild) return;

  let liveMap;
  try {
    liveMap = await fetchLiveStreams([...watchlist.values()]);
  } catch (err) {
    console.error('Error consultando la API de Twitch:', err);
    return;
  }

  console.log(
    `[poll] ${watchlist.size} canal(es) vigilados, ${liveMap.size} en vivo ahora: [${[...liveMap.keys()].join(', ')}]`
  );

  for (const [discordId, twitchLogin] of watchlist) {
    const stream = liveMap.get(twitchLogin.toLowerCase());
    const matchesCategory =
      !TWITCH_CATEGORY_FILTER ||
      (stream && stream.game_name?.toLowerCase() === TWITCH_CATEGORY_FILTER.toLowerCase());
    const isRelevantLive = Boolean(stream) && matchesCategory;
    const wasLive = liveNow.has(discordId);

    if (stream && TWITCH_CATEGORY_FILTER && !matchesCategory) {
      console.log(
        `[poll] ${twitchLogin} está en vivo pero en categoría "${stream.game_name}" (no coincide con "${TWITCH_CATEGORY_FILTER}") — no notifico.`
      );
    }

    if (isRelevantLive && !wasLive) {
      liveNow.add(discordId);
      await goLive(discordId, twitchLogin, stream);
    } else if (!isRelevantLive && wasLive) {
      liveNow.delete(discordId);
      await goOffline(discordId);
    }
  }
}

// ---------- Mensajes ----------

function buildStreamContent(member) {
  return `@everyone 🔴 **${member.displayName}** este weon esta en stream`;
}

function buildStreamEmbed(member, twitchLogin, stream) {
  const url = `https://twitch.tv/${twitchLogin}`;
  const embed = new EmbedBuilder()
    .setColor(0x9146ff)
    .setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL() })
    .setTitle(stream?.title || 'En vivo ahora')
    .setURL(url)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Categoría', value: stream?.game_name || 'Sin especificar', inline: true },
      { name: 'Canal', value: `[twitch.tv/${twitchLogin}](${url})`, inline: true }
    )
    .setFooter({ text: `${member.guild.name} • Stream en vivo` })
    .setTimestamp();

  if (stream?.thumbnail_url) {
    const img = stream.thumbnail_url.replace('{width}', '640').replace('{height}', '360');
    // cache-bust: Discord cachea la imagen por URL, y la miniatura de Twitch cambia con el tiempo.
    embed.setImage(`${img}?t=${Date.now()}`);
  }

  return embed;
}

function buildWelcomeEmbed(member) {
  return new EmbedBuilder()
    .setColor(0xc9a66b)
    .setAuthor({
      name: member.guild.name,
      iconURL: member.guild.iconURL() ?? undefined,
    })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setTitle('¡Bienvenido/a al servidor!')
    .setDescription(
      `Hola ${member}, gracias por sumarte a **${member.guild.name}**. Date una vuelta por las reglas y sentite libre de presentarte.`
    )
    .addFields({ name: 'Miembro N°', value: `${member.guild.memberCount}`, inline: true })
    .setFooter({ text: 'Que disfrutes tu estadía' })
    .setTimestamp();
}

// ---------- Eventos de stream ----------

async function goLive(discordId, twitchLogin, stream) {
  console.log(`[LIVE] ${twitchLogin} (discord ${discordId}) empezó a streamear: "${stream.title}"`);

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    console.error(`No encontré en el server al miembro ${discordId}`);
    return;
  }

  try {
    await member.roles.add(LIVE_ROLE_ID);
  } catch (err) {
    console.error(`No pude asignar el rol a ${member.user.tag}:`, err.message);
  }

  const channel = guild.channels.cache.get(CHANNEL_ID);
  if (!channel) {
    console.error(`No se encontró el canal con ID ${CHANNEL_ID}`);
    return;
  }

  try {
    await channel.send({
      content: buildStreamContent(member),
      embeds: [buildStreamEmbed(member, twitchLogin, stream)],
      allowedMentions: { parse: ['everyone'] },
    });
  } catch (err) {
    console.error('Error al enviar la notificación de stream:', err);
  }
}

async function goOffline(discordId) {
  console.log(`[OFFLINE] discord ${discordId} dejó de streamear`);

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  try {
    await member.roles.remove(LIVE_ROLE_ID);
  } catch (err) {
    console.error(`No pude quitar el rol a ${member.user.tag}:`, err.message);
  }
}

// ---------- Bienvenida ----------

client.on('guildMemberAdd', async (member) => {
  const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!channel) {
    console.error(`No se encontró el canal de bienvenida con ID ${WELCOME_CHANNEL_ID}`);
    return;
  }
  try {
    await channel.send({ content: `${member}`, embeds: [buildWelcomeEmbed(member)] });
  } catch (err) {
    console.error('Error al enviar el mensaje de bienvenida:', err);
  }
});

// ---------- Comandos ----------

const commandDef = new SlashCommandBuilder()
  .setName('streamwatch')
  .setDescription('Administra a quiénes vigila el bot para avisar cuando streamean en Twitch')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Agrega a una persona a la lista de streamers vigilados')
      .addUserOption((opt) =>
        opt.setName('usuario').setDescription('Persona en Discord').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('twitch')
          .setDescription('Su usuario de Twitch, tal cual en twitch.tv/usuario')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Quita a una persona de la lista')
      .addUserOption((opt) =>
        opt.setName('usuario').setDescription('Persona a quitar').setRequired(true)
      )
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Muestra la lista actual'))
  .addSubcommand((sub) =>
    sub
      .setName('test')
      .setDescription('Muestra cómo se ve el mensaje de aviso (no pingea a nadie de verdad)')
      .addUserOption((opt) =>
        opt.setName('usuario').setDescription('Simular con esta persona (default: vos)').setRequired(false)
      )
  )
  .toJSON();

const welcomeCommandDef = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Mensaje de bienvenida para gente nueva')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('test')
      .setDescription('Muestra cómo se ve el mensaje de bienvenida (no hace falta que entre alguien nuevo)')
      .addUserOption((opt) =>
        opt.setName('usuario').setDescription('Simular con esta persona (default: vos)').setRequired(false)
      )
  )
  .toJSON();

client.once('clientReady', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);

  try {
    guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    console.log(`Cache de miembros cargado: ${guild.members.cache.size} miembros.`);
  } catch (err) {
    console.error('No pude cachear el servidor/miembros:', err);
  }

  try {
    const rest = new REST().setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [commandDef, welcomeCommandDef],
    });
    console.log('Comandos /streamwatch y /welcome registrados.');
  } catch (err) {
    console.error('No pude registrar los comandos:', err);
  }

  try {
    await getTwitchToken();
    console.log('Token de Twitch obtenido correctamente.');
  } catch (err) {
    console.error('No pude autenticar con la API de Twitch:', err.message);
  }

  await initialSync();
  setInterval(pollTwitch, POLL_INTERVAL_MS);
  console.log(`Consultando Twitch cada ${POLL_INTERVAL_MS / 1000}s.`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error(`Error manejando /${interaction.commandName}:`, err);
    const message = {
      content: `⚠️ Algo falló ejecutando el comando: \`${err.message}\``,
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(message);
      } else {
        await interaction.reply(message);
      }
    } catch (replyErr) {
      console.error('No pude avisarle al usuario del error:', replyErr);
    }
  }
});

async function handleCommand(interaction) {
  if (interaction.commandName === 'welcome' && interaction.options.getSubcommand() === 'test') {
    const target = interaction.options.getUser('usuario') ?? interaction.user;
    const debugChannel = interaction.guild.channels.cache.get(DEBUG_CHANNEL_ID);
    if (!debugChannel) {
      await interaction.reply({
        content: `No encontré el canal de debug configurado (ID ${DEBUG_CHANNEL_ID}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const member = await interaction.guild.members.fetch(target.id);
    const preview = buildWelcomeEmbed(member);

    await debugChannel.send({
      content: `${member}`,
      embeds: [preview],
      allowedMentions: { parse: [] },
    });
    await interaction.reply({
      content: `✅ Mensaje de bienvenida de prueba enviado a <#${DEBUG_CHANNEL_ID}> (no generó ping real).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName !== 'streamwatch') return;

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const user = interaction.options.getUser('usuario', true);
    const twitchLogin = interaction.options.getString('twitch', true).trim().toLowerCase();
    watchlist.set(user.id, twitchLogin);
    saveWatchlist();
    await interaction.reply({
      content: `✅ ${user} agregado. Voy a vigilar **twitch.tv/${twitchLogin}**.`,
    });
  } else if (sub === 'remove') {
    const user = interaction.options.getUser('usuario', true);
    watchlist.delete(user.id);
    liveNow.delete(user.id);
    saveWatchlist();
    await interaction.reply({ content: `🗑️ ${user} quitado de la lista.` });
  } else if (sub === 'list') {
    if (watchlist.size === 0) {
      await interaction.reply({
        content: 'La lista está vacía. Agregá gente con `/streamwatch add`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = [...watchlist.entries()]
      .map(([id, login]) => `<@${id}> → twitch.tv/${login}`)
      .join('\n');
    await interaction.reply({
      content: `**Streamers vigilados:**\n${lines}`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (sub === 'test') {
    const target = interaction.options.getUser('usuario') ?? interaction.user;
    const debugChannel = interaction.guild.channels.cache.get(DEBUG_CHANNEL_ID);
    if (!debugChannel) {
      await interaction.reply({
        content: `No encontré el canal de debug configurado (ID ${DEBUG_CHANNEL_ID}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = await interaction.guild.members.fetch(target.id);
    const fakeStream = {
      title: 'Stream de prueba',
      game_name: TWITCH_CATEGORY_FILTER || 'WARDOGS',
      thumbnail_url: null,
    };
    const previewContent = buildStreamContent(member);
    const previewEmbed = buildStreamEmbed(member, 'ejemplo', fakeStream);

    // allowedMentions vacío: se ve el "@everyone" tal cual pero no pingea a nadie de verdad.
    await debugChannel.send({
      content: previewContent,
      embeds: [previewEmbed],
      allowedMentions: { parse: [] },
    });
    await interaction.reply({
      content: `✅ Mensaje de prueba enviado a <#${DEBUG_CHANNEL_ID}> (no pingeó a nadie realmente).`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

client.login(DISCORD_TOKEN);
