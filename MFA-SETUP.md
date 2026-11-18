# Verificación en dos pasos y avisos de acceso

Definí `MFA_ENCRYPTION_KEY` en el entorno del servidor: una clave aleatoria de 32 bytes codificada en base64. Por ejemplo, generala con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` y guardala como secreto en el proveedor. Reiniciá el backend después de configurarla.

La clave debe ser estable y compartirse entre todas las instancias del mismo entorno. Guardá una copia segura: cambiarla o perderla impide verificar los autenticadores existentes. Usá claves diferentes para bases de datos independientes y no subas la clave al repositorio.

Desde la app se configura un autenticador compatible con TOTP y se muestran códigos de respaldo antes de activar. El ingreso con contraseña exige el código; una passkey con verificación del usuario y el desbloqueo de un iPhone ya vinculado mantienen sus propios mecanismos. Los códigos de respaldo son de un solo uso. Si el frontend publicado no se actualizó, el formulario web antiguo no podrá pedir el código; hasta actualizarlo se puede ingresar allí con una passkey.

Con una sesión abierta se puede desactivar MFA con el PIN y un código del autenticador o respaldo, o con el PIN y la contraseña actual. Ambos métodos tienen límite de intentos.

Para permitir volver a consultar los códigos disponibles, los códigos nuevos se guardan cifrados con `MFA_ENCRYPTION_KEY` además de sus hashes de verificación. Un código usado se elimina de ambas listas. Ver la clave del autenticador y los códigos requiere una sesión y un código TOTP vigente sin usar. Los códigos creados antes de esta función solo existen como hashes: no pueden recuperarse y la persona puede generar otros tras confirmar que los anteriores dejarán de funcionar.

Se avisa de nuevos ingresos a las suscripciones push existentes y a Telegram si está conectado. Si no hay un canal habilitado, no se puede entregar el aviso. Un navegador se reconoce mediante una cookie que no sirve para autenticarse; si se borran sus datos, el próximo ingreso vuelve a generar un aviso. El desbloqueo habitual por PIN de un iPhone ya vinculado no genera avisos.

Al vincular o desbloquear un iPhone, se consulta su IP pública mediante IPWhois para mostrar ciudad, región y país aproximados. No se guarda la IP en texto; se conserva un hash para no repetir la consulta en cada desbloqueo. Las IP privadas, errores y demoras de la consulta no bloquean el acceso. La precisión depende de la red y las VPN; el servicio gratuito tiene un límite de solicitudes.
