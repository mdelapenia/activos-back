# Alertas push de dividendos

Las notificaciones usan Web Push y el proceso persistente del backend. El servidor revisa los pagos de las carteras suscritas al iniciar y cada 30 minutos; envía una vez por dispositivo, alerta y fecha de pago. Incluye pagos estimados identificados como tales. La consulta requiere `MASSIVE_API_KEY`.

## Configuración

En Railway configurá estas variables de entorno del servicio backend:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`: URL HTTPS de contacto o `mailto:` válido.
- `MASSIVE_API_KEY`: clave de la fuente de dividendos.

Para generar un par estable, ejecutá en `back` `npx web-push generate-vapid-keys` y copiá los valores a Railway. Guardá la clave privada como secreto, no la subas al repositorio. Conservá el mismo par entre despliegues e instancias: cambiarlo obliga a volver a activar las notificaciones en cada dispositivo. El entorno local tiene sus propias claves en `back/.env.local`.

Después de desplegar el frontend y el backend, abrí Dividendos, activá las notificaciones en el dispositivo y usá «Enviar prueba». La prueba se envía mediante Web Push desde el servidor. El navegador debe tener permiso para mostrar notificaciones. En iPhone y iPad, agregá Alza a la pantalla de inicio y abrila desde allí antes de activar el permiso.

El proceso de `back/index.mjs` debe permanecer activo para hacer las comprobaciones; las funciones sin proceso persistente necesitan un programador externo equivalente. El sistema operativo y el proveedor de push pueden demorar o bloquear la entrega.
