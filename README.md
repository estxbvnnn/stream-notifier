# discord-stream-notifier

Bot que anuncia con `@everyone` cuando un miembro con un rol determinado (ej. `@Streamer`) empieza a transmitir en Discord (Twitch/YouTube detectado por Discord, o "Go Live" con compartir pantalla).

## 1. Crear el bot en Discord

1. Andá a https://discord.com/developers/applications → **New Application**.
2. En **Bot**, creá el bot y copiá el **Token** (va en `.env`, nunca lo subas a git).
3. En la misma pestaña **Bot**, activá los dos **Privileged Gateway Intents**:
   - `PRESENCE INTENT`
   - `SERVER MEMBERS INTENT`
4. En **OAuth2 → URL Generator**, marcá el scope `bot` y los permisos:
   - `View Channels`, `Send Messages`, `Mention Everyone`
   Usá la URL generada para invitar el bot a tu server.

## 2. Configurar variables de entorno

Copiá `.env.example` a `.env` y completá:

```
DISCORD_TOKEN=el_token_de_tu_bot
CHANNEL_ID=id_del_canal_donde_se_notifica
ROLE_ID=id_del_rol_streamer
```

- `CHANNEL_ID`: click derecho en el canal → Copiar ID (necesitás el modo desarrollador activado en Discord: Ajustes → Avanzado → Modo desarrollador).
- `ROLE_ID`: click derecho en el rol (en la lista de roles del server) → Copiar ID. Si dejás `ROLE_ID` vacío, aplica a **cualquier** miembro del server.

## 3. Correrlo con Docker

```bash
docker compose up -d --build
```

Ver logs:

```bash
docker compose logs -f
```

Parar:

```bash
docker compose down
```

## Notas

- El bot solo notifica una vez por sesión de stream (no repite mientras la persona sigue en vivo).
- Para que Discord detecte el stream de Twitch/YouTube automáticamente, cada persona debe tener esa cuenta conectada en **Ajustes de usuario → Conexiones**, con "Mostrar en mi perfil" y "Mostrar Discord como en vivo" activados.
- Si preferís apuntar a personas específicas por ID en vez de por rol, decímelo y lo ajusto (lista de IDs en vez de `ROLE_ID`).
