// Script de un solo uso: pone el nombre y la foto de perfil del bot.
// Correr una vez con: node setup-profile.js
require('dotenv').config();
const path = require('node:path');
const { Client, GatewayIntentBits } = require('discord.js');

const { DISCORD_TOKEN } = process.env;
const BOT_NAME = 'WAWAS BOT';
const AVATAR_PATH = path.join(__dirname, 'avatar.png');

if (!DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN en el .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  try {
    console.log(`Conectado como ${client.user.tag}, aplicando cambios...`);

    await client.user.setAvatar(AVATAR_PATH);
    console.log('Avatar actualizado.');

    if (client.user.username !== BOT_NAME) {
      await client.user.setUsername(BOT_NAME);
      console.log(`Username actualizado a "${BOT_NAME}".`);
    } else {
      console.log('El username ya era el correcto.');
    }

    console.log('Listo. Podés cerrar este proceso.');
  } catch (err) {
    console.error('Error al actualizar el perfil del bot:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(DISCORD_TOKEN);
