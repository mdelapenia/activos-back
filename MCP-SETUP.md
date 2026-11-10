# Conectar agentes de IA

Activos ofrece un servidor MCP remoto en `https://activos-nu.vercel.app/mcp`, publicado a través del frontend de Vercel y atendido por el backend de Railway. El transporte usa OAuth 2.1 con PKCE, registro dinámico de clientes, tokens de acceso de una hora y refresh tokens rotativos. El consentimiento y las autorizaciones se guardan en MongoDB.

## Despliegue

1. Desplegá el backend actualizado en Railway y el frontend actualizado en Vercel. El `vercel.json` enruta `/mcp`, `/oauth/*` y `/.well-known/*` al backend.
2. En Railway, configurá `APP_ORIGIN` con el origen exacto del frontend publicado, por ejemplo `https://activos-nu.vercel.app`. El servidor MCP usa ese origen como issuer. Si se usa otro dominio público, definí también `MCP_ISSUER_URL` con el origen público exacto del servidor MCP.
3. Confirmá que `MONGODB_URI` y `MONGODB_DB` sean los mismos que usa Activos y que Railway pueda crear índices en las colecciones MCP nuevas.
4. En Activos, abrí **Configuración → Agentes IA** para copiar la URL, ver los permisos y revocar conexiones.

## Conectar ChatGPT o Claude

En **Configuración → Agentes IA** de Activos, usá **Abrir ChatGPT** o **Abrir Claude**. En cada cliente, buscá la opción para agregar un conector personalizado/remoto (MCP) y pegá `https://activos-nu.vercel.app/mcp`. La disponibilidad y ubicación pueden variar según el plan o la configuración del espacio de trabajo. Al autorizar, iniciá sesión con tu correo y PIN de Activos; el PIN se envía únicamente a Activos.

Si actualizás el servidor y el cliente todavía muestra que no hay herramientas, eliminá esa conexión guardada en ChatGPT/Claude y volvé a agregarla para que consulte nuevamente la lista MCP.

Después de autorizar, volvé a **Configuración → Agentes IA** en Activos y tocá **Ya autoricé**. Si el agente aparece en la lista, regresá a ChatGPT/Claude y actualizá el conector; no vuelvas a enviar el formulario de autorización que ya completaste.

La lectura comparte nombres de activos, tipo, monto, moneda, unidades, fechas y preferencias básicas. El permiso de escritura es opcional: permite agregar, reemplazar o eliminar posiciones, pero no operar, mover fondos ni editar ventas, alertas, importaciones o claves. Las solicitudes de cambio deben revisarse en el cliente de IA. Los datos enviados al agente quedan sujetos a las políticas del proveedor.

Cada conexión se puede revocar desde **Configuración → Agentes IA**. La revocación invalida tanto tokens de acceso como de renovación. MCP es ahora la única integración de agentes de IA disponible dentro de Activos; no requiere guardar API keys.
