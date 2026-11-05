# Alertas por Telegram

1. Creá un bot con @BotFather y obtené su token y nombre de usuario.
2. Configurá en el entorno del backend `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (sin @), `TELEGRAM_WEBHOOK_SECRET` (aleatorio, 32 a 256 caracteres alfanuméricos, guion o guion bajo) y `TELEGRAM_WEBHOOK_URL` (URL HTTPS pública completa terminada en `/api/telegram/webhook`). En Railway también hay que configurar estas variables en el servicio desplegado.
3. Reiniciá el backend y abrí Configuración → Notificaciones → Telegram. Elegí Conectar, abrí el enlace y presioná Iniciar en el chat privado. El enlace de vinculación vence en diez minutos y solo puede usarse una vez.
4. Volvé a Alza y enviá una prueba. Podés desconectarlo desde el mismo lugar.

El webhook se registra al iniciar la vinculación y reemplaza cualquier webhook previo del mismo bot. Las alertas automáticas de precio y dividendos usan el mismo contenido y horario de no molestar que push; requieren que el proceso del backend esté en ejecución. El token del bot es secreto y no debe compartirse ni incluirse en el frontend.

En el chat privado vinculado, `/ayuda` muestra los comandos de consulta: `/cartera`, `/activos`, `/activo SOL`, `/wallets`, `/distribucion`, `/dividendos`, `/alertas` y `/dolar`. `/wallets` muestra hasta 15 tokens por dirección e indica si la lista está incompleta. Los comandos no modifican la cartera. Si una misma cuenta de Telegram está vinculada a más de una cuenta de Alza, las consultas quedan bloqueadas hasta desconectar las demás.

`/clear` intenta borrar mensajes recientes del chat de las últimas 48 horas, revisando hasta 1000 identificadores. `/menu` abre el teclado de opciones; `/alza` ofrece enlaces a la aplicación.
