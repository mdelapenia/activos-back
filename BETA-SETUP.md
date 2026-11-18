# Beta

La app guarda las inscripciones y los mensajes en MongoDB, vinculados a la cuenta. Al eliminar la cuenta también se eliminan esos datos. El formulario de comentarios está disponible desde Ajustes → Beta, incluso antes de inscribirse.

Para abrir TestFlight tras inscribirse, configurá `EXPO_PUBLIC_TESTFLIGHT_URL` en la compilación de la app con el enlace público de invitación. Sin ese enlace la inscripción se guarda, pero no se ofrece la instalación. La disponibilidad y los cupos dependen de TestFlight. Publicá el backend actualizado para habilitar los dos formularios.

Para consultar las respuestas desde `back`, con la conexión de MongoDB configurada en el entorno:

```sh
node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/beta.mjs inscripciones
node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/beta.mjs feedback
```

La salida contiene datos personales: tratala como información privada. Los comentarios no se envían por correo automáticamente.
