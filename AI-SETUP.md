# Agentes de IA

Se retiraron el chat interno de mercado, el asistente de objetivos y la configuración de API keys. La integración disponible para usar agentes externos es el servidor MCP de Activos: seguí [MCP-SETUP.md](./MCP-SETUP.md).

Las API keys cifradas que se hubieran guardado antes de este cambio permanecen en la base de datos, pero la aplicación ya no las consulta ni las acepta desde su API. No se borran automáticamente para evitar eliminar credenciales guardadas sin confirmación.
