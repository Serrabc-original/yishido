# Debugging

## Logs locales

El proyecto usa logs estructurados en JSON lines. Para pruebas locales, guarda los archivos en:

- `logs/agent-YYYY-MM-DD.log`
- `logs/errors-YYYY-MM-DD.log`

`logs/` y `*.log` estan ignorados por Git. No subas logs reales al repositorio.

El Worker emite eventos estructurados con `event`, `traceId`, `turnId`, `doName` y `details`. Si estas usando `wrangler dev`, captura la salida del proceso en un archivo dentro de `logs/`.

Ejemplo:

```powershell
npm run dev *> logs/agent-2026-06-12.log
```

## Leer logs recientes

```powershell
npm run logs:latest
```

Puedes pasar la cantidad de lineas:

```powershell
node scripts/read-latest-logs.js 250
```

## Analizar errores

```powershell
npm run logs:analyze
```

El analisis busca:

- errores repetidos;
- fallbacks enviados al usuario;
- audios con timeout;
- imagenes fallidas;
- turns sin respuesta;
- turns con audio pendiente;
- turns con media pendiente;
- orquestador sin JSON valido;
- errores agrupados por `traceId`;
- ultimas conversaciones problematicas.

## Como pedirle a Codex que investigue un bug

Pasa el `traceId` y pega el resultado de:

```powershell
npm run logs:analyze
```

Formato recomendado:

```text
Investiga este bug usando logs.
traceId: trace_...
No cambies Meta ni publicacion automatica.
Mantén intactos audio queue, image queue, /reset, Google Sheets y campaign_assets.
```

## Eventos criticos

Eventos base:

- `WEBHOOK_RECEIVED`
- `MESSAGE_NORMALIZED`
- `TURN_CREATED`
- `TURN_BUFFER_READY`
- `TURN_CONTEXT_POLICY`
- `MEDIA_BATCH_CREATED`
- `MEDIA_ASSET_ANALYSIS_START`
- `MEDIA_ASSET_ANALYSIS_OK`
- `MEDIA_ASSET_ANALYSIS_FAILED`
- `AUDIO_RECEIVED`
- `AUDIO_JOB_RECEIVED`
- `AUDIO_DOWNLOAD_START`
- `AUDIO_DOWNLOAD_OK`
- `AUDIO_TRANSCRIPTION_START`
- `AUDIO_TRANSCRIPTION_OK`
- `AUDIO_TRANSCRIPTION_FAILED`
- `VIDEO_RECEIVED`
- `FILE_RECEIVED`
- `ORCHESTRATOR_INPUT_COMPACTED`
- `ORCHESTRATOR_PROVIDER_SELECTED`
- `ORCHESTRATOR_ACTIONS_SELECTED`
- `USER_RESPONSE_SENT`
- `USER_FALLBACK_SENT`
- `ERROR_CAPTURED`

## Privacidad

No guardes secretos ni payloads crudos de clientes. El logger redacta llaves y telefonos en campos conocidos, pero los logs siguen siendo datos operativos sensibles.
