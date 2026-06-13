# Lists

`src/modules/lists/` is an active core utility for WhatsApp lists. State is kept per Durable Object conversation in `coreUtilityState`.

## Supported Commands

- `Hazme una lista de compras con arroz, pollo, leche y huevos`
- `Anota leche, pan y huevos en mi lista del super`
- `Agrega cargadores tipo C a lista de inventario`
- `Muestrame mi lista`
- `Quita huevos de la lista del super`
- `Marca pollo como comprado`
- `Crea una lista llamada clientes pendientes`
- `/lists`

## API

- `parseListCommand(text)`
- `createList`
- `addListItems`
- `removeListItems`
- `markListItemDone`
- `listItems`

## Activation

```text
ENABLE_LISTS=true
CORE_UTILITIES_SANDBOX=true
```

When enabled, list requests are handled before marketing/orchestrator routing. If the user does not name a list, the active list is used; otherwise the default is `pendientes`.

## Logs

- `LIST_COMMAND_PARSED`
- `LIST_CREATED`
- `LIST_ITEMS_ADDED`
- `LIST_ITEMS_REMOVED`
- `LIST_ITEMS_LISTED`
- `LIST_ITEM_MARKED_DONE`
