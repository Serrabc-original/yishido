# Lists And Notes

`src/modules/lists/` provides a base utility for notes and lists.

## Supported Commands

- `Anota leche, pan y huevos en mi lista del súper`
- `Agrega cargadores tipo C a lista de inventario`
- `Muéstrame mi lista de pendientes`
- `Quita huevos de la lista del súper`
- `Marca como hecho llamar al cliente`
- `Crea una lista llamada clientes pendientes`

## API

- `parseListCommand(text)`
- `createList`
- `addListItems`
- `removeListItems`
- `markListItemDone`
- `listItems`

## Activation

```text
ENABLE_LISTS=false
```

When disabled, list requests pass to the orchestrator. When enabled, the core can handle list operations in Durable Object state or local mock storage.

## Logs

- `LIST_COMMAND_PARSED`
- `LIST_CREATED`
- `LIST_ITEMS_ADDED`
- `LIST_ITEMS_REMOVED`
- `LIST_ITEMS_LISTED`
- `LIST_ITEM_MARKED_DONE`
