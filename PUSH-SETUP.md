# Alertas push de dividendos

El backend genera automáticamente un par de claves VAPID la primera vez que se necesita y lo guarda en la colección `push_config` de MongoDB. La clave pública se entrega a los dispositivos autenticados; la privada permanece en la base y se usa solo en el servidor. Restringí el acceso a MongoDB y protegé sus copias de seguridad: quien tenga acceso a esa colección puede obtener la clave privada.

No hace falta cargar variables VAPID para una instalación nueva. Se puede seguir usando un par existente mediante `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`; ambas variables deben estar presentes y tienen prioridad sobre las claves guardadas en MongoDB. `VAPID_SUBJECT` es opcional: si no está definido se usa `APP_ORIGIN` cuando es HTTPS o la dirección pública de Alza. No cambies ni borres el par que está en uso sin prever que los dispositivos tendrán que volver a activar sus notificaciones.

El servicio necesita MongoDB y `MASSIVE_API_KEY` para dividendos. El proceso persistente `back/index.mjs` revisa precios y dividendos al iniciar y cada cinco minutos; evita envíos duplicados, respeta el horario de no molestar e identifica los pagos estimados. Los botones de prueba envían avisos de prueba.

Los resúmenes se configuran en Configuración → Notificaciones. El proceso del backend comprueba cada cinco minutos los resúmenes diarios o semanales pendientes en hora argentina, y los envía por los canales seleccionados que estén activos. Se respeta el horario de no molestar; si coincide con la hora prevista, el envío queda pendiente hasta que termine o llegue la siguiente fecha programada. El cambio compara el valor total con el último resumen exitoso de esa frecuencia y moneda, por lo que puede incluir aportes y retiros. Para recibir dividendos se requiere `MASSIVE_API_KEY`; si faltan datos, el resumen lo indica. La primera entrega no tiene un valor anterior para comparar.

Después de desplegar el frontend y el backend, abrí Dividendos o Tu espacio → Notificaciones, activá las notificaciones en el dispositivo y usá «Enviar prueba». El navegador debe tener permiso para mostrarlas. En iPhone y iPad, agregá Alza a la pantalla de inicio y abrila desde allí antes de activar el permiso.

Las funciones sin proceso persistente necesitan un programador externo equivalente. El sistema operativo y el proveedor de push pueden demorar o bloquear la entrega.
