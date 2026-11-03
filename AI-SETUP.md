# Asistente de mercado

Configurar `AI_ENCRYPTION_KEY` en el entorno del servidor con una clave aleatoria de 32 bytes codificada en base64. Se puede generar con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Conservarla de forma segura y estable: cambiarla impide descifrar las claves ya guardadas. Configurar la misma clave en todas las instancias del backend.

Cada usuario guarda por separado sus API keys de OpenAI, Anthropic o Gemini desde el chat. La app las cifra con AES-256-GCM y no las devuelve al navegador. Las consultas y búsquedas pueden generar cargos en la cuenta del proveedor. Las suscripciones a las aplicaciones de chat no necesariamente incluyen acceso a sus APIs.

Opcionalmente se pueden definir `OPENAI_CHAT_MODEL`, `CLAUDE_CHAT_MODEL` y `GEMINI_CHAT_MODEL` para cambiar los modelos predeterminados. Los modelos deben admitir las herramientas de búsqueda de su proveedor.
