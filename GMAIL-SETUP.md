# Conectar Gmail para importar comprobantes de Lemon

La aplicación consulta Gmail con permiso de solo lectura; no necesita tu contraseña ni envía correos. Por defecto busca mensajes de `lemoncash.com.ar` y `lemon.me`; también permite indicar una dirección de remitente específica. Luego lee el texto y PDF compatibles y deja las operaciones pendientes de revisión. La consulta se inicia con «Buscar comprobantes» en Importar; no funciona en segundo plano. Se consultan hasta los 50 mensajes más recientes que coinciden; la pantalla avisa si hay más.

## 1. Crear el proyecto en Google Cloud

1. Entrá a https://console.cloud.google.com/ y creá o elegí un proyecto.
2. En **APIs y servicios > Biblioteca**, habilitá **Gmail API**.
3. En **Google Auth Platform**, configurá la pantalla de consentimiento. Elegí la audiencia externa si vas a usar una cuenta personal; mientras esté en modo de prueba, agregá tu dirección en **Usuarios de prueba**.
4. Agregá el permiso `https://www.googleapis.com/auth/gmail.readonly`. Este permiso permite leer los correos de la cuenta, aunque la aplicación busque solo los de Lemon.
5. En **Clientes > Crear cliente**, elegí **Aplicación web**. En orígenes autorizados agregá `https://activos-nu.vercel.app`; en URI de redirección autorizados agregá `https://activos-back-production.up.railway.app/api/imports/gmail/callback`. Guardá el ID y secreto de cliente.

## 2. Completar el entorno del backend

En `back/.env` completá los valores agregados:

```dotenv
GOOGLE_CLIENT_ID=el-id-de-cliente-de-google
GOOGLE_CLIENT_SECRET=el-secreto-de-cliente-de-google
GOOGLE_REDIRECT_URI=https://activos-back-production.up.railway.app/api/imports/gmail/callback
GMAIL_TOKEN_KEY=clave-base64-de-32-bytes
APP_ORIGIN=https://activos-nu.vercel.app
```

`GMAIL_TOKEN_KEY` cifra los tokens de Gmail en la base de datos. Se generó una clave al agregar la variable si no existía; mantenela estable y respaldada. Si necesitás crear otra, ejecutá `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` y pegá el resultado. Cambiarla después de conectar cuentas impide leer sus tokens anteriores: habrá que volver a conectarlas. No compartas las claves ni subas el `.env` al repositorio.

El backend también carga `back/.env.local`: si allí hay variables con los mismos nombres, sus valores pueden tener prioridad. Para la app publicada configurá también estas variables en Railway, en el servicio del backend; el archivo local `.env` no cambia la configuración de Railway. `APP_ORIGIN` debe ser el origen exacto del frontend y `GOOGLE_REDIRECT_URI` debe coincidir exactamente con el registrado en Google.

## 3. Conectar y consultar

1. Reiniciá el backend y abrí la aplicación.
2. Entrá a **Importar > Conectar Gmail**, elegí tu cuenta y aceptá el acceso de lectura de Google.
3. Al volver a la aplicación, pulsá **Buscar comprobantes**. Revisá los campos y confirmá solo las operaciones correctas. La app no las agrega a la cartera automáticamente.
4. Para quitar el acceso, pulsá **Desconectar**. También podés revocarlo desde la configuración de seguridad de tu cuenta de Google.

La aplicación reconoce el formato de correo de Lemon y PDF de texto de Lemon o Alpaca implementados; formatos diferentes, PDF escaneados y adjuntos de más de 1,2 MB pueden no leerse. Google puede limitar o vencer las autorizaciones de proyectos en modo de prueba; si ocurre, volvé a conectar la cuenta. Para publicar la app a otros usuarios, Google puede exigir verificación y controles adicionales por el alcance restringido de Gmail.

Para desarrollo local independiente, configurá `APP_ORIGIN=http://localhost:5173` y `GOOGLE_REDIRECT_URI=http://localhost:3000/api/imports/gmail/callback` y registrá ambas direcciones en el cliente OAuth de Google. Como `.env.local` puede tener prioridad, ajustá allí también `APP_ORIGIN`.
