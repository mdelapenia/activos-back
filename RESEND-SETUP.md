# Recepción de comprobantes con Resend

1. En Resend, habilitá la recepción y copiá el dominio de entrada asignado (sin dirección ni @): https://resend.com/docs/dashboard/receiving/introduction
2. Creá una API key con permisos para leer correos recibidos. Completá `RESEND_API_KEY` y `RESEND_INBOUND_DOMAIN` en `back/.env` y también en las variables del servicio del backend en Railway para que funcionen en la app publicada. No guardes la clave en el repositorio.
3. Reiniciá o desplegá el backend con esas variables. En Importar aparece una dirección distinta para cada cuenta.
4. Reenviá un correo a esa dirección y pulsá «Buscar correos». Se leen el texto y los PDF compatibles, y las operaciones quedan pendientes para revisar.

No hace falta configurar un webhook: la consulta se realiza al pulsar el botón. Se examinan hasta 500 correos recientes de la cuenta Resend y hasta 50 destinados a cada usuario por consulta; si se alcanza el límite, se informa en pantalla. Los PDF deben contener texto y pesar como máximo 1,2 MB. Actualmente se reconocen comprobantes de Lemon y resúmenes Alpaca. No se usa IA.
